import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';

process.env.PROXY_MATE_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-mate-integration-'));
const { ProxyEngine } = await import('../src/lib/proxy.mjs');
const { PacServer } = await import('../src/lib/pac.mjs');
const { makeTools } = await import('../src/lib/tools.mjs');
const { MCP_TOOLS, successToolResult } = await import('../src/lib/mcp-contract.mjs');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function requestViaProxy(proxyPort, targetUrl, {
  method = 'POST',
  headers = { authorization: 'Bearer top-secret', cookie: 'session=private', 'content-type': 'application/json' },
  body = '{"hello":"world"}',
  proxyHost = '127.0.0.1',
} = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxyHost, port: proxyPort, method, path: targetUrl, headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(Object.assign(new Error('Proxy test request exceeded its deadline.'), { code: 'TEST_REQUEST_TIMEOUT' })));
    req.end(body);
  });
}

test('optional SOCKS listener forwards local development traffic', async (t) => {
  const upstream = http.createServer((_req, res) => {
    res.setHeader('connection', 'close');
    res.end('through-socks');
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const engine = new ProxyEngine({ sessionId: `socks-${Date.now()}` });
  await engine.start({ port: 0, enableSocks: true });
  t.after(() => engine.stop());

  const socket = net.connect(engine.port, '127.0.0.1');
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  socket.write(Buffer.from([5, 1, 0]));
  const [greeting] = await once(socket, 'data');
  assert.deepEqual([...greeting.subarray(0, 2)], [5, 0]);
  socket.write(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, upstreamPort >> 8, upstreamPort & 255]));
  const [connected] = await once(socket, 'data');
  assert.equal(connected[1], 0);
  socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\nConnection: close\r\n\r\n`);
  const chunks = [];
  socket.on('data', (chunk) => chunks.push(chunk));
  await once(socket, 'end');
  assert.match(Buffer.concat(chunks).toString(), /through-socks/);
  assert.equal(engine.socksEnabled, true);
});

test('custom CA configuration requires a key and certificate pair', async () => {
  const engine = new ProxyEngine({ sessionId: `custom-ca-${Date.now()}` });
  await assert.rejects(
    engine.start({ caKeyPath: '/private/missing-key.pem' }),
    (error) => error.code === 'CUSTOM_CA_PAIR_REQUIRED',
  );
});

test('proxy defaults to loopback clients and requires explicit LAN consent', async (t) => {
  const lan = Object.values(os.networkInterfaces()).flat()
    .find((address) => address?.family === 'IPv4' && !address.internal);
  if (!lan) return t.skip('no non-loopback IPv4 interface is available');

  const upstream = http.createServer((_req, res) => res.end('reachable'));
  const upstreamPort = await new Promise((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '0.0.0.0', () => resolve(upstream.address().port));
  });
  // macOS grants Local Network access per executable. A newly installed Node
  // may have loopback access while LAN traffic waits for that OS grant.
  const reachable = await new Promise((resolve) => {
    const check = http.get({ host: lan.address, port: upstreamPort, path: '/' }, (res) => {
      res.resume(); res.on('end', () => resolve(true));
    });
    const deadline = setTimeout(() => check.destroy(), 2500);
    check.on('close', () => clearTimeout(deadline));
    check.on('error', () => resolve(false));
  });
  if (!reachable) {
    upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve));
    return t.skip('LAN inaccessible to this Node executable; macOS Local Network permission is a separate physical-device gate.');
  }
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const engine = new ProxyEngine({ sessionId: 'remote-guard' });

  await engine.start({ port: 0 });
  await assert.rejects(requestViaProxy(engine.port, `http://${lan.address}:${upstreamPort}/`, {
    method: 'GET', headers: {}, body: null, proxyHost: lan.address,
  }));
  await engine.stop();

  await engine.start({ port: 0, allowRemote: true, allowedRemoteIps: [lan.address] });
  t.after(() => engine.stop());
  const response = await requestViaProxy(engine.port, `http://${lan.address}:${upstreamPort}/`, {
    method: 'GET', headers: {}, body: null, proxyHost: lan.address,
  });
  assert.equal(response.status, 200);
});

test('captures traffic, redacts secrets, exports curl, and clears session', async (t) => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(201, {
      'content-type': 'application/json',
      'set-cookie': ['server=secret', 'session=private'],
      'x-env-type': ['staging', 'staging'],
    });
    res.end('{"captured":true}');
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const engine = new ProxyEngine();
  const tools = makeTools({ engine, pacServer: new PacServer(), mode: 'test' });
  await tools.start_proxy({ port: 0, auto_setup: false });
  t.after(() => tools.stop_proxy());

  const target = `http://127.0.0.1:${upstreamPort}/users?token=query-secret`;
  const response = await requestViaProxy(engine.port, target, { body: '{"hello":"world","password":"body-secret"}' });
  assert.equal(response.status, 201);

  const listed = await tools.get_flows({ limit: 10 });
  assert.equal(listed.flows.length, 1);
  assert.match(listed.flows[0].url, /%5BREDACTED%5D/);
  const id = listed.flows[0].id;
  const detail = await tools.get_flow_detail({ flow_id: id });
  assert.equal(detail.request.headers.authorization, '[REDACTED]');
  assert.equal(detail.request.cookies[0].value, '[REDACTED]');
  assert.equal(JSON.parse(detail.request.body_inline).password, '[REDACTED]');
  assert.equal(detail.response.statusCode, 201);
  assert.deepEqual(detail.response.headers['x-env-type'], ['staging', 'staging']);
  assert.equal(detail.response.headers['set-cookie'], '[REDACTED]');
  const result = successToolResult('get_flow_detail', {}, detail);
  assert.equal(MCP_TOOLS.find((tool) => tool.name === 'get_flow_detail')
    .outputSchema.safeParse(result.structuredContent).success, true);
  const durable = await engine.sessionStore.getFlow({ sessionId: engine.sessionId, flowId: id });
  assert.equal(durable.request.headers.authorization, '[REDACTED]');
  assert.match(durable.request.url, /%5BREDACTED%5D/);
  assert.equal(JSON.parse(durable.request.body_inline).password, '[REDACTED]');
  assert.equal(durable.request.body_redacted_at_capture, true);
  const curl = await tools.export_flow_curl({ flow_id: id });
  assert.doesNotMatch(curl.curl, /top-secret|query-secret|session=private|body-secret/);
  assert.ok(curl.redacted_fields.length >= 2);
  const swift = await tools.export_flow_swift({ flow_id: id });
  assert.doesNotMatch(swift.code, /top-secret|query-secret|session=private|body-secret/);

  const filtered = await tools.filter_flows({
    conditions: [{ field: 'status', operator: 'equals', value: 201 }],
  });
  assert.equal(filtered.flows.length, 1);
  await tools.clear_session({ scope: "all", confirm_shared: true });
  assert.equal((await tools.get_flows()).flows.length, 0);
});

test('sensitive storage grant persists raw HTTP data only in all capture mode', async (t) => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'server=raw-secret' });
    res.end('{"token":"response-secret"}');
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const target = `http://127.0.0.1:${upstreamPort}/private?token=query-secret`;

  const textEngine = new ProxyEngine({ storeSensitiveData: true, sessionId: `sensitive-text-${Date.now()}` });
  await textEngine.start({ port: 0, captureBodyMode: 'text' });
  await requestViaProxy(textEngine.port, target, { body: '{"password":"request-secret"}' });
  await textEngine.stop();
  const textFlow = [...textEngine.flows.values()][0];
  assert.match(textFlow.request.url, /%5BREDACTED%5D/);
  assert.equal(textFlow.request.headers.authorization, '[REDACTED]');
  assert.equal(JSON.parse(textFlow.request.body_inline).password, '[REDACTED]');
  assert.equal(textFlow.response.headers['set-cookie'], '[REDACTED]');
  assert.equal(JSON.parse(textFlow.response.body_inline).token, '[REDACTED]');

  const allEngine = new ProxyEngine({ storeSensitiveData: true, sessionId: `sensitive-all-${Date.now()}` });
  await allEngine.start({ port: 0, captureBodyMode: 'all' });
  await requestViaProxy(allEngine.port, target, { body: '{"password":"request-secret"}' });
  await allEngine.stop();
  const allFlow = [...allEngine.flows.values()][0];
  assert.match(allFlow.request.url, /query-secret/);
  assert.equal(allFlow.request.headers.authorization, 'Bearer top-secret');
  assert.equal(JSON.parse(allFlow.request.body_inline).password, 'request-secret');
  assert.equal(allFlow.response.headers['set-cookie'], 'server=raw-secret');
  assert.equal(JSON.parse(allFlow.response.body_inline).token, 'response-secret');
});

test('capture persistence failures are counted, diagnosed, and can fail closed', async (t) => {
  const failingStore = {
    ensureSession: async () => {},
    listFlows: async () => ({ flows: [], next_cursor: null }),
    getFlow: async () => null,
    appendFlow: async () => { const error = new Error('disk unavailable'); error.code = 'EIO'; throw error; },
    updateFlow: async () => { throw new Error('unexpected update'); },
  };
  const upstream = http.createServer((_req, res) => res.end('ok'));
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const engine = new ProxyEngine({
    sessionStore: failingStore,
    sessionId: `persistence-failure-${Date.now()}`,
    failClosedOnPersistenceError: true,
  });
  await engine.start({ port: 0 });
  t.after(() => engine.stop());
  await Promise.allSettled([requestViaProxy(engine.port, `http://127.0.0.1:${upstreamPort}/`)]);
  for (let attempt = 0; attempt < 50 && engine.persistenceFailures === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const health = engine.persistenceHealth();
  assert.equal(health.ok, false);
  assert.equal(health.fail_closed, true);
  assert.ok(health.failures_total >= 1);
  assert.equal(health.last_error.code, 'EIO');
  assert.equal(engine.recording, false);
  assert.equal(engine.diagnostics.some((entry) => entry.kind === 'session-store-error'), true);
});

test('default WebSocket backend restores durable redacted snapshots', async () => {
  const connectionId = `ws-durable-${Date.now()}`;
  const first = new ProxyEngine({ storeSensitiveData: true });
  first.webSocketStore.onRequest({
    id: connectionId,
    method: 'GET',
    url: 'wss://socket.example.test/chat?token=query-secret',
    headers: { authorization: 'Bearer header-secret' },
  });
  first.webSocketStore.onMessageReceived({ id: connectionId, message: { data: '{"password":"message-secret"}' } });
  await first.stop();

  const restored = new ProxyEngine({ storeSensitiveData: true });
  await restored.start({ port: 0, captureBodyMode: 'text' });
  await restored.stop();
  const connection = restored.webSocketStore.getConnection({ connectionId, includeSensitive: true });
  const messages = restored.webSocketStore.listMessages({ connectionId, includeSensitive: true });
  assert.match(connection.request.url, /%5BREDACTED%5D/);
  assert.equal(connection.request.headers.authorization, '[REDACTED]');
  assert.equal(JSON.parse(messages.messages[0].data.text).password, '[REDACTED]');
});

test('Map Local, Map Remote, and Blacklist rules execute and persist normalized types', async (t) => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`upstream:${req.url}`);
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const engine = new ProxyEngine();
  const tools = makeTools({ engine, pacServer: new PacServer(), mode: 'test' });
  await tools.start_proxy({ port: 0, auto_setup: false });
  t.after(() => tools.stop_proxy());

  const localUrl = 'http://local-rule.test/value';
  await tools.create_map_local({ url: localUrl, status: 202, content_type: 'application/json', body: '{"mocked":true}' });
  const local = await requestViaProxy(engine.port, localUrl, { method: 'GET', headers: {}, body: null });
  assert.equal(local.status, 202);
  assert.equal(local.body, '{"mocked":true}');

  const sourceUrl = 'http://source-rule.test/forwarded';
  await tools.create_map_remote({ from_url: sourceUrl, to_url: `http://127.0.0.1:${upstreamPort}` });
  const remote = await requestViaProxy(engine.port, sourceUrl, { method: 'GET', headers: {}, body: null });
  assert.equal(remote.status, 200);
  assert.equal(remote.body, 'upstream:/forwarded');

  const blockedUrl = 'http://blocked-rule.test/private';
  await tools.create_blacklist({ url: blockedUrl });
  const blocked = await requestViaProxy(engine.port, blockedUrl, { method: 'GET', headers: {}, body: null });
  assert.equal(blocked.status, 403);
  assert.match(blocked.body, /Blocked by proxy-mate/);

  const types = new Set((await tools.list_rules()).rules.map((rule) => rule.type));
  assert.deepEqual(types, new Set(['map_local', 'map_remote', 'blacklist']));

  const exportPath = path.join(process.env.PROXY_MATE_HOME, 'portable-rules.json');
  await tools.export_rules({ path: exportPath });
  await tools.clear_rules();
  assert.equal((await tools.list_rules()).rules.length, 0);
  const imported = await tools.import_rules({ path: exportPath, replace: true });
  assert.equal(imported.registered, 3);
  assert.deepEqual(imported.failed, []);
  const localAfterImport = await requestViaProxy(engine.port, localUrl, { method: 'GET', headers: {}, body: null });
  assert.equal(localAfterImport.status, 202);
  assert.equal(localAfterImport.body, '{"mocked":true}');
});

test('capture sessions survive proxy restarts and expose cursor/live APIs', async (t) => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"durable":true}');
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const engine = new ProxyEngine({ sessionId: `durable-${Date.now()}` });
  const tools = makeTools({ engine, pacServer: new PacServer(), mode: 'test' });
  await tools.start_proxy({ port: 0, auto_setup: false });
  const target = `http://127.0.0.1:${upstreamPort}/durable`;
  const waiting = tools.wait_for_flow({ url_contains: '/durable', timeout_ms: 5000 });
  await requestViaProxy(engine.port, target, { method: 'GET', headers: {}, body: null });
  const observed = await waiting;
  assert.equal(observed.matched, true);
  const flowId = observed.flow.id;

  await tools.stop_proxy();
  await tools.start_proxy({ port: 0, auto_setup: false });
  t.after(() => tools.stop_proxy());
  assert.equal((await tools.get_flow_detail({ flow_id: flowId })).response.statusCode, 200);
  const page = await tools.get_flows({ session_id: engine.sessionId, limit: 10 });
  assert.equal(page.flows.some((flow) => flow.id === flowId), true);
  assert.match(page.snapshot_id, new RegExp(`^${engine.sessionId}:`));
});
