import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

process.env.PROXY_MCP_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-mcp-upstream-wiring-'));

const { ProxyEngine } = await import('../src/lib/proxy.mjs');
const { makeTools } = await import('../src/lib/tools.mjs');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function requestViaProxy(proxyPort, targetUrl) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'GET',
      path: targetUrl,
      headers: { connection: 'close' },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('unmatched and enabled pass-through traffic use the authenticated upstream without exposing credentials', async (t) => {
  const expectedAuthorization = `Basic ${Buffer.from('alice:very-secret').toString('base64')}`;
  const observed = [];
  const upstream = http.createServer((request, response) => {
    observed.push({
      url: request.url,
      authorization: request.headers['proxy-authorization'] ?? null,
    });
    if (request.headers['proxy-authorization'] !== expectedAuthorization) {
      response.writeHead(407, { 'proxy-authenticate': 'Basic realm="test"' });
      response.end('proxy authentication required');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(`via-upstream:${request.url}`);
  });
  const upstreamPort = await listen(upstream);

  const engine = new ProxyEngine({ sessionId: `upstream-wiring-${Date.now()}` });
  const tools = makeTools({ engine, pacServer: {}, mode: 'test' });
  t.after(async () => {
    await engine.stop();
    await close(upstream);
  });

  const credentialedUrl = `http://alice:very-secret@127.0.0.1:${upstreamPort}`;
  const started = await tools.start_proxy({
    port: 0,
    auto_setup: false,
    upstream_proxy: { proxyUrl: credentialedUrl },
  });

  assert.equal(started.upstream_proxy.proxyUrl, `http://127.0.0.1:${upstreamPort}/`);
  assert.equal(started.upstream_proxy.hasCredentials, true);
  assert.equal(JSON.stringify(started).includes('alice'), false);
  assert.equal(JSON.stringify(started).includes('very-secret'), false);

  const unmatchedTarget = 'http://origin.invalid/unmatched?case=default';
  const unmatched = await requestViaProxy(engine.port, unmatchedTarget);
  assert.equal(unmatched.status, 200);
  assert.equal(unmatched.body, `via-upstream:${unmatchedTarget}`);

  const status = await tools.get_proxy_status();
  assert.equal(status.upstream_proxy.proxyUrl, `http://127.0.0.1:${upstreamPort}/`);
  assert.equal(status.upstream_proxy.hasCredentials, true);
  assert.equal(JSON.stringify(status.upstream_proxy).includes('alice'), false);
  assert.equal(JSON.stringify(status.upstream_proxy).includes('very-secret'), false);
  assert.equal(status.upstream_proxy.proxyUrl.includes('@'), false);

  const ruledTarget = 'http://origin.invalid/enabled-rule?case=passthrough';
  const registered = await tools.create_network_condition({
    rule_id: 'upstream-pass-through',
    url: ruledTarget,
    delay_ms: 1,
  });
  assert.equal(registered.rule.enabled, true);
  assert.equal(registered.rule.type, 'network_condition');

  const ruled = await requestViaProxy(engine.port, ruledTarget);
  assert.equal(ruled.status, 200);
  assert.equal(ruled.body, `via-upstream:${ruledTarget}`);
  assert.deepEqual(observed.map(({ url }) => url), [unmatchedTarget, ruledTarget]);
  assert(observed.every(({ authorization }) => authorization === expectedAuthorization));
});

test('makeTools exposes adapter and extended capability surfaces without starting sockets', async () => {
  const engine = {
    sessionId: 'surface-only',
    diagnostics: [],
    maxDiagnostics: 100,
    listRuleConfigs: () => [],
  };
  const tools = makeTools({ engine, pacServer: {}, mode: 'test' });

  const listed = await tools.list_capture_adapters();
  assert.deepEqual(listed.adapters.map(({ id }) => id), [
    'apple-simulator',
    'apple-device-manual',
    'android-adb',
    'docker',
    'terminal-env',
  ]);

  const adapter = await tools.get_capture_adapter({ adapter_id: 'android-adb' });
  assert.equal(adapter.adapter.capabilities.proxy_configuration, 'automatable_with_confirmation');
  assert.equal(adapter.adapter.capabilities.certificate_pinning_bypass, false);

  const plan = await tools.build_capture_setup_plan({
    adapter_id: 'terminal-env',
    options: { proxy_port: 8080 },
  });
  assert.equal(plan.executes_automatically, false);
  assert.equal(plan.steps[0].action.type, 'environment');

  const capabilities = await tools.get_extended_capabilities();
  assert.equal(capabilities.capture_adapters.automatic_mutation, false);
  assert.equal(capabilities.upstream_proxy.credentials.public_output_redacted, true);
  assert.equal(capabilities.websocket_engine.live_message_mutation, false);
  assert.equal(capabilities.websocket_engine.live_message_injection, false);
});

