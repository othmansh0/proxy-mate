import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.PROXY_MATE_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-mate-breakpoints-integration-'));
const { ProxyEngine } = await import('../src/lib/proxy.mjs');
const { makeTools } = await import('../src/lib/tools.mjs');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function requestViaProxy(proxyPort, targetUrl, { headers = {}, timeout = 3_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: proxyPort, method: 'GET', path: targetUrl, headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.setTimeout(timeout, () => req.destroy(new Error('request timed out')));
    req.once('error', reject);
    req.end();
  });
}

async function waitForPending(engine, direction, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = engine.breakpoints.listPending({ direction })[0];
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for a ${direction} breakpoint`);
}

test('request breakpoints can synthesize a response without contacting upstream', async (t) => {
  const engine = new ProxyEngine();
  await engine.start({ port: 0 });
  t.after(() => engine.stop());
  const tools = makeTools({ engine, pacServer: {}, mode: 'test' });
  await tools.create_breakpoint({
    rule_id: 'request-break', direction: 'request',
    url_pattern: '^http://breakpoint-request\\.test/', timeout_ms: 2_000,
  });

  const responsePromise = requestViaProxy(engine.port, 'http://breakpoint-request.test/value?token=secret', {
    headers: { authorization: 'Bearer secret' },
  });
  await waitForPending(engine, 'request');
  const pending = (await tools.list_pending_breakpoints({ direction: 'request' })).breakpoints[0];
  assert.equal(pending.rule_id, 'request-break');
  assert.equal(pending.message.request.headers.authorization, '[REDACTED]');
  assert.match(pending.message.request.url, /token=%5BREDACTED%5D/);

  const resolution = await tools.resolve_breakpoint({
    breakpoint_id: pending.id,
    action: 'respond',
    response: { statusCode: 202, headers: { 'content-type': 'text/plain' }, body: 'approved' },
  });
  assert.equal(resolution.outcome.action, 'respond');
  const response = await responsePromise;
  assert.equal(response.status, 202);
  assert.equal(response.headers['content-type'], 'text/plain');
  assert.equal(response.body, 'approved');
});

test('response breakpoints can edit an upstream response', async (t) => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'x-upstream': 'yes' });
    res.end('upstream');
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const engine = new ProxyEngine();
  await engine.start({ port: 0 });
  t.after(() => engine.stop());
  const target = `http://127.0.0.1:${upstreamPort}/response`;
  await engine.registerRule({
    rule_id: 'response-break', type: 'breakpoint', direction: 'response',
    url_pattern: `^${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, timeout_ms: 2_000,
  });

  const responsePromise = requestViaProxy(engine.port, target);
  const pending = await waitForPending(engine, 'response');
  assert.equal(pending.message.response.status_code, 200);
  assert.equal(pending.message.response.body.preview, 'upstream');
  engine.breakpoints.resolve(pending.id, {
    action: 'modify',
    changes: { statusCode: 299, headers: { 'content-type': 'text/plain', 'x-breakpoint': 'edited' }, body: 'changed' },
  });
  const response = await responsePromise;
  assert.equal(response.status, 299);
  assert.equal(response.headers['x-breakpoint'], 'edited');
  assert.equal(response.body, 'changed');
});

test('rule replacement preserves pending breakpoints; proxy stop releases them', async (t) => {
  const upstream = http.createServer((_req, res) => res.end('continued'));
  const upstreamPort = await listen(upstream);
  const engine = new ProxyEngine();
  await engine.start({ port: 0 });
  t.after(async () => { await engine.stop(); upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); });
  await engine.registerRule({
    rule_id: 'lifecycle-break', type: 'breakpoint', direction: 'request',
    url_pattern: `^http://127\\.0\\.0\\.1:${upstreamPort}/`, timeout_ms: 2_000,
  });

  const firstRequest = requestViaProxy(engine.port, `http://127.0.0.1:${upstreamPort}/first`).catch((error) => error);
  await waitForPending(engine, 'request');
  await engine.registerRule({
    rule_id: 'unrelated', type: 'blacklist', url_pattern: '^http://unrelated\\.test/', status: 403,
  });
  assert.equal(engine.breakpoints.listPending().length, 1);
  engine.breakpoints.resolve(engine.breakpoints.listPending()[0].id, { action: 'continue' });
  await firstRequest;

  const secondRequest = requestViaProxy(engine.port, `http://127.0.0.1:${upstreamPort}/second`).catch((error) => error);
  await waitForPending(engine, 'request');
  const stopped = await Promise.race([
    engine.stop(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('engine.stop hung on a pending breakpoint')), 1_000)),
  ]);
  assert.equal(stopped.status, 'stopped');
  assert.equal(engine.breakpoints.listPending().length, 0);
  await secondRequest;
  await new Promise((resolve) => upstream.close(resolve));
});

test('scoped breakpoint hook uses request-time device identity and preserves owner metadata', async (t) => {
  const { createRoutingClaimsStore } = await import('../src/lib/routing-claims.mjs');
  const claims = createRoutingClaimsStore();
  const owner = { client_id: 'device-a', task_id: 'task-a' };
  const a = 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA';
  const b = 'BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB';
  for (const [client_id, task_id, device] of [[owner.client_id, owner.task_id, a], ['device-b', 'task-b', b]]) {
    await claims.upsertClaim({ client_id, task_id, device_udids: [device], domains: ['127.0.0.1'], durationSeconds: 60 });
  }
  t.after(() => claims.removeAllClaims());
  let device = a;
  const engine = new ProxyEngine({ deviceResolver: () => device });
  await engine.start({ port: 0 });
  t.after(() => engine.stop());
  const upstream = http.createServer((_req, res) => res.end('upstream'));
  const port = await listen(upstream);
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const tools = makeTools({ engine, pacServer: {}, clientRegistry: { isAlive: () => true } });
  const result = await tools.create_breakpoint({ rule_id: 'scoped-device', url_pattern: '^http://127\\.0\\.0\\.1:', direction: 'request' }, owner);
  assert.equal(result.rule.scope, 'mine');
  assert.deepEqual(result.rule.owner, owner);
  await new Promise(setImmediate);
  const pendingResponse = requestViaProxy(engine.port, `http://127.0.0.1:${port}/a`);
  const pending = await waitForPending(engine, 'request');
  assert.deepEqual(pending.owner, owner);
  await tools.resolve_breakpoint({ breakpoint_id: pending.id, action: 'continue' });
  assert.equal((await pendingResponse).body, 'upstream');
  device = b;
  assert.equal((await requestViaProxy(engine.port, `http://127.0.0.1:${port}/b`)).body, 'upstream');
  device = null;
  assert.equal((await requestViaProxy(engine.port, `http://127.0.0.1:${port}/ambiguous`)).body, 'upstream');
  assert.equal(engine.breakpoints.getStatus().skipped_out_of_scope, 2);
});
