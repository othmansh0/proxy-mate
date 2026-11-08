import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
process.env.PROXY_MCP_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-network-safety-'));
const { detectPrimaryNetworkService, selectNetworkService } = await import('../src/lib/network-service.mjs');
const { applyPacRouting, clearPacRouting, buildPacText, validateRoutingDomains, PacServer } = await import('../src/lib/pac.mjs');
const { clearState, readState } = await import('../src/lib/state.mjs');

test('active service follows SystemConfiguration, not enabled Wi-Fi order', async () => {
  const id = '12345678-1234-1234-1234-123456789012';
  const selected = await detectPrimaryNetworkService({ query: async (query) => query.includes('Global')
    ? `PrimaryService : ${id}\nPrimaryInterface : en5` : 'UserDefinedName : USB Ethernet\n' });
  assert.equal(selected, 'USB Ethernet');
  const deps = { run: async () => ({ stdout: 'header\nWi-Fi\nUSB Ethernet\n*Disabled\n' }), primary: async () => selected };
  assert.equal(await selectNetworkService(undefined, deps), 'USB Ethernet');
  await assert.rejects(selectNetworkService('Disabled', deps), { code: 'NETWORK_SERVICE_UNAVAILABLE' });
  await assert.rejects(selectNetworkService(undefined, { ...deps, primary: async () => null }), { code: 'NETWORK_SERVICE_UNDETERMINED' });
});

test('PAC explicitly falls back to DIRECT, scopes hosts and preserves loopback bypass', () => {
  const context = vm.createContext({ isPlainHostName: (host) => !host.includes('.'), shExpMatch: (host, pattern) => host === pattern });
  vm.runInContext(buildPacText(['api.example.test'], '127.0.0.1', 8080), context);
  assert.equal(context.FindProxyForURL('https://api.example.test/', 'api.example.test'), 'PROXY 127.0.0.1:8080; DIRECT');
  assert.equal(context.FindProxyForURL('https://other.test/', 'other.test'), 'DIRECT');
  assert.equal(context.FindProxyForURL('http://127.0.0.1:8018/', '127.0.0.1'), 'DIRECT');
  assert.throws(() => validateRoutingDomains(['*']), { code: 'BROAD_ROUTING_REQUIRES_CONSENT' });
  assert.throws(() => validateRoutingDomains(['https://api.test/']), { code: 'ROUTING_DOMAIN_INVALID' });
  assert.deepEqual(validateRoutingDomains(['API.TEST', 'api.test']), ['api.test']);
});

function fakeNetwork(initial = { enabled: false, url: '' }) {
  let actual = { ...initial }, failEnable = false;
  const changes = [];
  return { changes, actual: () => actual, replace: (value) => { actual = value; }, fail: () => { failEnable = true; },
    run: async (_file, [command, service, value]) => {
      if (command === '-getautoproxyurl') return { stdout: `URL: ${actual.url}\nEnabled: ${actual.enabled ? 'Yes' : 'No'}\n` };
      if (command === '-getwebproxy' || command === '-getsecurewebproxy') return { stdout: 'Enabled: No\n' };
      changes.push({ command, service, value });
      if (command === '-setautoproxyurl') actual.url = value;
      if (command === '-setautoproxystate') {
        if (failEnable && value === 'on') throw new Error('injected enable failure');
        actual.enabled = value === 'on';
      }
      return { stdout: '' };
    } };
}

test('failed PAC enable rolls back a partial networksetup write', async (t) => {
  await clearState();
  const net = fakeNetwork({ enabled: false, url: 'https://prior.test/proxy.pac' }); net.fail();
  const pac = new PacServer(); t.after(() => pac.stop());
  await assert.rejects(applyPacRouting({ domains: ['api.test'], proxyPort: 8080, pacPort: 0, pacServer: pac,
    run: net.run, select: async () => 'Ethernet' }), /enable failure/);
  assert.deepEqual(net.actual(), { enabled: false, url: 'https://prior.test/proxy.pac' });
  assert.equal((await readState()).routing_active, false);
  assert.equal(pac.server, null);
});

test('existing PAC conflicts are preserved and do not start a new PAC listener', async () => {
  await clearState(); const net = fakeNetwork({ enabled: true, url: 'https://vpn.test/pac' });
  const pac = new PacServer();
  await assert.rejects(applyPacRouting({ domains: ['api.test'], proxyPort: 8080, pacPort: 0, pacServer: pac,
    run: net.run, select: async () => 'Ethernet' }), { code: 'ROUTING_CONFLICT' });
  assert.equal(pac.server, null); assert.deepEqual(net.changes, []);
});

test('a routing lease restores the previous configuration without stopping capture', async (t) => {
  await clearState(); const net = fakeNetwork(); const pac = new PacServer(); t.after(() => pac.stop());
  await applyPacRouting({ domains: ['api.test'], proxyPort: 8080, pacPort: 0, pacServer: pac,
    durationSeconds: 1, run: net.run, select: async () => 'Ethernet' });
  assert.equal(net.actual().enabled, true);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.deepEqual(net.actual(), { enabled: false, url: '' });
  assert.equal((await readState()).routing_active, false);
});

test('external changes during a capture are preserved on reapply and cleanup', async (t) => {
  await clearState(); const net = fakeNetwork(); const pac = new PacServer(); t.after(() => pac.stop());
  const args = { domains: ['api.test'], proxyPort: 8080, pacPort: 0, pacServer: pac, run: net.run, select: async () => 'Ethernet' };
  await applyPacRouting(args);
  net.replace({ enabled: true, url: 'https://vpn.test/new.pac' });
  await assert.rejects(applyPacRouting(args), { code: 'ROUTING_CONFLICT' });
  await clearPacRouting({ pacServer: pac, run: net.run });
  assert.deepEqual(net.actual(), { enabled: true, url: 'https://vpn.test/new.pac' });
});

test('busy-port PAC diagnostics bound an untrusted endless response', async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ns-proxy-autoconfig' });
    res.write(Buffer.alloc(16384, 'x'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const start = Date.now();
  await assert.rejects(new PacServer().start(server.address().port), { code: 'PAC_PORT_BUSY' });
  assert.ok(Date.now() - start < 2000);
});
