import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

process.env.PROXYFAN_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'proxyfan-upstream-wiring-'));

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
      headers: { connection: 'close', host: new URL(targetUrl).host },
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

// Mockttp routes every upstream-proxied request through an HttpsProxyAgent, so
// even plain http:// targets are CONNECT-tunnelled. The fake upstream therefore
// has to terminate CONNECT and bridge the tunnel to a real origin server.
test('unmatched and enabled pass-through traffic use the authenticated upstream without exposing credentials', async (t) => {
  const expectedAuthorization = `Basic ${Buffer.from('alice:very-secret').toString('base64')}`;
  const observed = [];
  const originRequests = [];
  const sockets = new Set();

  const track = (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  };

  const origin = http.createServer((request, response) => {
    originRequests.push({
      url: request.url,
      host: request.headers.host,
      marker: request.headers['x-rule-marker'] ?? null,
    });
    response.writeHead(200, { 'content-type': 'text/plain', connection: 'close' });
    response.end(`via-upstream:${request.url}`);
  });
  origin.on('connection', track);
  const originPort = await listen(origin);

  const upstream = http.createServer((request, response) => {
    // Nothing should reach the upstream as a plain proxied request.
    response.writeHead(400, { 'content-type': 'text/plain', connection: 'close' });
    response.end('unexpected non-tunnelled request');
  });
  upstream.on('connection', track);
  upstream.on('connect', (request, clientSocket, head) => {
    track(clientSocket);
    observed.push({
      authority: request.url,
      authorization: request.headers['proxy-authorization'] ?? null,
    });
    clientSocket.on('error', () => {});
    if (request.headers['proxy-authorization'] !== expectedAuthorization) {
      clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\n\r\n');
      return;
    }
    const tunnel = net.connect(originPort, '127.0.0.1', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) tunnel.write(head);
      clientSocket.pipe(tunnel);
      tunnel.pipe(clientSocket);
    });
    track(tunnel);
    tunnel.on('error', () => clientSocket.destroy());
  });
  const upstreamPort = await listen(upstream);

  const engine = new ProxyEngine({ sessionId: `upstream-wiring-${Date.now()}` });
  const tools = makeTools({ engine, pacServer: {}, mode: 'test' });
  // Sockets and listeners are torn down in a finally so a rejected engine.stop()
  // cannot strand them on the event loop and hang the whole runner.
  t.after(async () => {
    try {
      await engine.stop();
    } finally {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await close(upstream);
      await close(origin);
    }
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

  const unmatchedPath = '/unmatched?case=default';
  const unmatchedTarget = `http://origin.invalid${unmatchedPath}`;
  const unmatched = await requestViaProxy(engine.port, unmatchedTarget);
  assert.equal(unmatched.status, 200);
  assert.equal(unmatched.body, `via-upstream:${unmatchedPath}`);

  const status = await tools.get_proxy_status();
  assert.equal(status.upstream_proxy.proxyUrl, `http://127.0.0.1:${upstreamPort}/`);
  assert.equal(status.upstream_proxy.hasCredentials, true);
  assert.equal(JSON.stringify(status.upstream_proxy).includes('alice'), false);
  assert.equal(JSON.stringify(status.upstream_proxy).includes('very-secret'), false);
  assert.equal(status.upstream_proxy.proxyUrl.includes('@'), false);

  // The rule URL carries a query string on purpose: since 0.7.0 the first '?'
  // in `url` is always the query separator, split into `match_query` rather
  // than matched against mockttp's query-stripped url_pattern. This is a live
  // regression guard that the split still lets the rule fire end to end.
  const ruledPath = '/enabled-rule?case=passthrough';
  const ruledTarget = `http://origin.invalid${ruledPath}`;
  const registered = await tools.create_network_condition({
    rule_id: 'upstream-pass-through',
    url: ruledTarget,
    delay_ms: 1,
    request_transform: { update_headers: { 'x-rule-marker': 'network-condition' } },
  });
  assert.equal(registered.rule.enabled, true);
  assert.equal(registered.rule.type, 'network_condition');

  const ruled = await requestViaProxy(engine.port, ruledTarget);
  assert.equal(ruled.status, 200);
  assert.equal(ruled.body, `via-upstream:${ruledPath}`);

  // Both the unmatched pass-through and the rule-matched pass-through must have
  // been tunnelled through the configured upstream, with credentials attached.
  assert.deepEqual(observed.map(({ authority }) => authority), [
    'origin.invalid:80',
    'origin.invalid:80',
  ]);
  assert(observed.every(({ authorization }) => authorization === expectedAuthorization));

  // The tunnelled requests reached the real origin addressed to the original
  // host, and the marker proves the second one was served by the rule rather
  // than falling back to the unmatched pass-through.
  assert.deepEqual(originRequests, [
    { url: unmatchedPath, host: 'origin.invalid', marker: null },
    { url: ruledPath, host: 'origin.invalid', marker: 'network-condition' },
  ]);
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

