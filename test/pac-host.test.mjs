import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import { createPacHost, ExternalPacServer, createDaemonPacServer } from '../src/lib/pac-host.mjs';
import { createRoutingClaimsStore } from '../src/lib/routing-claims.mjs';
import { startGuardian } from '../src/guardian.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pac-host-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let clock = Date.now();
  const now = () => clock;
  const claimsStore = createRoutingClaimsStore({ directory, now });
  const host = createPacHost({ port: 0, directory, claimsStore, now });
  await host.start(); t.after(() => host.stop());
  return { host, claimsStore, advance: () => { clock += 501; },
    state: value => fs.writeFile(path.join(directory, 'state.json'), typeof value === 'string' ? value : JSON.stringify(value)),
    corruptClaims: () => fs.writeFile(path.join(directory, 'routing-claims.json'), '{'),
    get: async (route = '/proxy.pac', options) => fetch(`http://127.0.0.1:${host.port}${route}`, options),
  };
}
function resolvePac(body, host) {
  const context = { isPlainHostName: h => !h.includes('.'), shExpMatch: (h, glob) => h === glob };
  vm.runInNewContext(body, context);
  return context.FindProxyForURL('https://' + host, host);
}

test('host unions live claims and legacy domains, preserves escaping and loopback bypass', async t => {
  const f = await fixture(t);
  await f.claimsStore.upsertClaim({ client_id: 'a', domains: ['api.example'], durationSeconds: 30 });
  await f.claimsStore.upsertClaim({ client_id: 'b', domains: ['expired.example'], durationSeconds: 1 });
  f.advance(); f.advance();
  await f.state({ routing_active: true, domains: ['legacy.example', 'quote".example'], proxy_port: 4567 });
  const response = await f.get(); const body = await response.text();
  assert.equal(response.headers.get('content-type'), 'application/x-ns-proxy-autoconfig');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  for (const domain of ['api.example', 'legacy.example', 'quote".example']) assert.equal(resolvePac(body, domain), 'PROXY 127.0.0.1:4567; DIRECT');
  for (const domain of ['expired.example', '127.0.0.1', 'localhost', '::1']) assert.equal(resolvePac(body, domain), 'DIRECT');
  assert.equal(await (await f.get('/')).text(), body);
  assert.equal((await f.get('/other')).status, 404);
  assert.equal((await f.get('/', { method: 'POST', body: 'ignored' })).status, 404);
  const status = await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: f.host.port, headers: { 'content-length': '1' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(status, 404);
});

test('host is DIRECT without domains and fails closed on corrupt claims or state', async t => {
  const f = await fixture(t);
  assert.equal(resolvePac(await (await f.get()).text(), 'api.example'), 'DIRECT');
  await f.state({ routing_active: true, domains: ['api.example'] }); f.advance();
  assert.match(resolvePac(await (await f.get()).text(), 'api.example'), /PROXY/);
  await f.corruptClaims(); f.advance();
  assert.equal(resolvePac(await (await f.get()).text(), 'api.example'), 'DIRECT');
  await f.claimsStore.removeAllClaims();
  await f.claimsStore.upsertClaim({ client_id: 'b', domains: ['api.example'], durationSeconds: 30 });
  await f.state('{'); f.advance();
  assert.equal(resolvePac(await (await f.get()).text(), 'api.example'), 'DIRECT');
});

test('host tracks proxy port and keeps claims after daemon state and adapter are cleared', async t => {
  const f = await fixture(t);
  await f.claimsStore.upsertClaim({ client_id: 'a', domains: ['api.example'], durationSeconds: 30 });
  const adapter = new ExternalPacServer();
  assert.equal(await adapter.start(f.host.port), f.host.port);
  adapter.setBody('ignored'); adapter.setLease(1); await adapter.stop();
  assert.equal(adapter.port, null); assert.equal(adapter.server, null); assert.equal(adapter.leaseTimer, null);
  for (const [state, port] of [[{ proxy_port: 9876, daemon_proxy_port: 9999 }, 9876], [{ daemon_proxy_port: 9999 }, 9999], [{}, 8080]]) {
    await f.state(state); f.advance();
    assert.equal(resolvePac(await (await f.get()).text(), 'api.example'), `PROXY 127.0.0.1:${port}; DIRECT`);
  }
});

test('external adapter rejects absent and foreign hosts; daemon adapter logs fallback and serves its body', async t => {
  const f = await fixture(t); const port = f.host.port; await f.host.stop();
  await assert.rejects(new ExternalPacServer().start(port), { code: 'PAC_HOST_UNAVAILABLE' });
  const logs = [];
  const adapter = createDaemonPacServer({ env: { PROXYFAN_PAC_HOST: 'guardian' }, log: (...args) => logs.push(args) });
  t.after(() => adapter.stop()); adapter.setBody('fallback body');
  await adapter.start(port);
  assert.equal(await (await fetch(`http://127.0.0.1:${adapter.port}/proxy.pac`)).text(), 'fallback body');
  assert.ok(logs.some(args => args.join(' ').includes('fallback')));
  await adapter.stop();
  const foreign = http.createServer((req, res) => res.end('foreign'));
  await new Promise(r => foreign.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => foreign.close(r)));
  await assert.rejects(new ExternalPacServer().start(foreign.address().port), { code: 'PAC_HOST_UNAVAILABLE' });
});

for (const busy of [false, true]) test(`guardian PAC lifecycle with busy=${busy}`, async t => {
  const f = await fixture(t); const port = f.host.port;
  if (!busy) await f.host.stop();
  const handlers = {}, exits = [], logs = [];
  const controller = startGuardian({ tick: async () => {}, env: { PROXYFAN_PAC_HOST: 'guardian', PROXYFAN_PAC_PORT: String(port) },
    pacHostOptions: { claimsStore: f.claimsStore, readState: async () => null },
    interval: () => 1, clear: () => {}, once: (sig, fn) => { handlers[sig] = fn; },
    exit: code => exits.push(code), log: (...args) => logs.push(args) });
  t.after(() => controller.stop());
  await controller.ready;
  assert.equal((await fetch(`http://127.0.0.1:${port}/proxy.pac`)).status, 200);
  if (busy) assert.ok(logs.some(args => args[1] === 'PAC host unavailable'));
  await handlers[busy ? 'SIGINT' : 'SIGTERM'](); assert.deepEqual(exits, [0]);
  if (!busy) await assert.rejects(fetch(`http://127.0.0.1:${port}/proxy.pac`));
});


test('external detection accepts a large valid union PAC', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 4; i++) await f.claimsStore.upsertClaim({ client_id: `client-${i}`,
    domains: Array.from({ length: 64 }, (_, j) => `${i}-${j}.${'a'.repeat(60)}.example`), durationSeconds: 30 });
  const adapter = new ExternalPacServer();
  assert.equal(await adapter.start(f.host.port), f.host.port);
});

test('host caches briefly, expires claims promptly and fails closed on read exceptions', async t => {
  let clock = 1000, reads = 0, fail = false;
  const host = createPacHost({ port: 0, now: () => clock,
    claimsStore: { listClaims: async () => [{ domains: ['api.example'], expires_at: new Date(1100).toISOString() }] },
    readState: async () => { reads++; if (fail) throw new Error('unreadable'); return {}; } });
  await host.start(); t.after(() => host.stop());
  const get = async () => (await fetch(`http://127.0.0.1:${host.port}/`)).text();
  assert.match(resolvePac(await get(), 'api.example'), /PROXY/);
  await get(); assert.equal(reads, 1);
  clock = 1100;
  assert.equal(resolvePac(await get(), 'api.example'), 'DIRECT');
  clock = 1700; fail = true;
  assert.equal(resolvePac(await get(), 'api.example'), 'DIRECT');
});

test('claims-managed state never resurrects expired domains', async t => {
  const f = await fixture(t);
  await f.claimsStore.upsertClaim({ client_id: 'a', domains: ['expired.example'], durationSeconds: 1 });
  await f.state({ routing_active: true, routing_mode: 'claims', domains: ['expired.example'], proxy_port: 4567 });
  f.advance(); f.advance();
  assert.equal(resolvePac(await (await f.get()).text(), 'expired.example'), 'DIRECT');
});
