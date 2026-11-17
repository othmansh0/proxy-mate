import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.PROXY_MATE_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-mate-control-'));
const { ControlServer, probeDaemon, callDaemon } = await import('../src/lib/control.mjs');
const { readHandshake } = await import('../src/lib/state.mjs');
const { SERVER_VERSION } = await import('../src/lib/config.mjs');

function rawControlRequest({ port, path = '/health', method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path, method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

test('control health and RPC require the private bearer token', async (t) => {
  const control = new ControlServer({ port: 0, tools: { echo: async (args) => args } });
  await control.start();
  t.after(() => control.stop());
  const handshake = await readHandshake();
  assert.equal(await probeDaemon(handshake.controlUrl, 'wrong-token'), false);
  assert.equal(await probeDaemon(handshake.controlUrl, handshake.token), true);
  for (const [headers, service] of [[{}, 'proxy-mcp'], [{ 'x-proxy-mate-client': '1' }, 'proxy-mate']]) {
    const response = await rawControlRequest({ port: control.port,
      headers: { authorization: `Bearer ${handshake.token}`, ...headers } });
    assert.equal(JSON.parse(response.body).service, service);
  }
  assert.deepEqual(await callDaemon({ ...handshake, tool: 'echo', args: { ok: 1 } }), { ok: 1 });
});

test('RPC identifies refreshed bridges while accepting older clients without metadata', async (t) => {
  const control = new ControlServer({ port: 0, tools: { get_proxy_status: async (_args, context) => ({ bridge_version: context.bridge_version }) } });
  await control.start();
  t.after(() => control.stop());
  const handshake = await readHandshake();
  assert.equal((await callDaemon({ ...handshake, tool: 'get_proxy_status' })).bridge_version, SERVER_VERSION);
  const older = await rawControlRequest({ port: new URL(handshake.controlUrl).port, path: '/rpc', method: 'POST',
    headers: { authorization: `Bearer ${handshake.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'get_proxy_status', args: {} }) });
  assert.equal(older.status, 200);
  assert.equal(JSON.parse(older.body).result.bridge_version, null);
});

test('daemon RPC preserves machine-actionable tool error fields', async (t) => {
  const control = new ControlServer({
    port: 0,
    tools: {
      fail: async () => {
        const error = new Error('simulator trust could not be verified');
        error.code = 'SIMULATOR_CA_UNTRUSTED';
        error.retryable = true;
        error.recovery = ['Confirm trust in Apple Settings', 'Retry diagnosis'];
        error.details = { udid: 'test-device' };
        throw error;
      },
    },
  });
  await control.start();
  t.after(() => control.stop());
  const handshake = await readHandshake();

  await assert.rejects(
    callDaemon({ ...handshake, tool: 'fail', args: {} }),
    (error) => {
      assert.equal(error.code, 'SIMULATOR_CA_UNTRUSTED');
      assert.equal(error.retryable, true);
      assert.deepEqual(error.recovery, ['Confirm trust in Apple Settings', 'Retry diagnosis']);
      assert.deepEqual(error.details, { udid: 'test-device' });
      return true;
    },
  );
});

test('breakpoint resolution and reads are not blocked behind serialized mutations', async (t) => {
  let releaseMutation;
  let mutationEntered;
  const entered = new Promise((resolve) => { mutationEntered = resolve; });
  const held = new Promise((resolve) => { releaseMutation = resolve; });
  const control = new ControlServer({
    port: 0,
    tools: {
      start_proxy: async () => { mutationEntered(); await held; return { status: 'started' }; },
      stop_proxy: async () => ({ status: 'stopped' }),
      resolve_breakpoint: async () => ({ status: 'resolved' }),
      get_proxy_status: async () => ({ running: true }),
    },
  });
  await control.start();
  t.after(() => control.stop());
  const handshake = await readHandshake();

  const start = callDaemon({ ...handshake, tool: 'start_proxy', args: {} });
  await entered;
  assert.deepEqual(await callDaemon({ ...handshake, tool: 'resolve_breakpoint', args: { breakpoint_id: 'test', action: 'continue' } }), { status: 'resolved' });
  assert.deepEqual(await callDaemon({ ...handshake, tool: 'get_proxy_status', args: {} }), { running: true });

  const stopped = callDaemon({ ...handshake, tool: 'stop_proxy', args: {} });
  let stopCompleted = false;
  stopped.then(() => { stopCompleted = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopCompleted, false);
  releaseMutation();
  await start;
  assert.deepEqual(await stopped, { status: 'stopped' });
});

test('daemon RPC cancellation aborts the underlying tool operation', async (t) => {
  let operationAborted;
  let operationStarted;
  const aborted = new Promise((resolve) => { operationAborted = resolve; });
  const started = new Promise((resolve) => { operationStarted = resolve; });
  const control = new ControlServer({
    port: 0,
    tools: {
      wait: async (_args, { signal }) => new Promise((_resolve, reject) => {
        operationStarted();
        signal.addEventListener('abort', () => {
          operationAborted();
          reject(signal.reason);
        }, { once: true });
      }),
    },
  });
  await control.start();
  t.after(() => control.stop());
  const handshake = await readHandshake();
  const controller = new AbortController();
  const call = callDaemon({ ...handshake, tool: 'wait', signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(call, (error) => error.code === 'REQUEST_CANCELLED');
  await aborted;
});

test('control tokens enforce observe, control, and sensitive scopes', async (t) => {
  const control = new ControlServer({
    port: 0,
    scopes: ['observe'],
    tools: {
      get_proxy_status: async () => ({ running: false }),
      remove_rule: async () => ({ removed: true }),
      get_flow_detail: async () => ({ id: 'flow' }),
    },
  });
  await control.start();
  t.after(() => control.stop());
  const handshake = await readHandshake();
  assert.deepEqual(handshake.scopes, ['observe']);
  assert.deepEqual(await callDaemon({ ...handshake, tool: 'get_proxy_status' }), { running: false });
  await assert.rejects(
    callDaemon({ ...handshake, tool: 'remove_rule', args: { rule_id: 'x' } }),
    (error) => error.code === 'FORBIDDEN_SCOPE' && error.details.required_scope === 'control',
  );
  await assert.rejects(
    callDaemon({ ...handshake, tool: 'get_flow_detail', args: { flow_id: 'x', include_sensitive: true } }),
    (error) => error.code === 'FORBIDDEN_SCOPE' && error.details.required_scope === 'sensitive',
  );
});

test('control plane validates Host and Origin before accepting authenticated requests', async (t) => {
  const control = new ControlServer({ port: 0, tools: {} });
  await control.start();
  t.after(() => control.stop());
  const handshake = await readHandshake();
  const authorization = `Bearer ${handshake.token}`;

  const foreignHost = await rawControlRequest({
    port: control.port,
    headers: { authorization, host: 'attacker.example' },
  });
  assert.equal(foreignHost.status, 421);
  assert.equal(JSON.parse(foreignHost.body).error.code, 'INVALID_HOST');

  const foreignOrigin = await rawControlRequest({
    port: control.port,
    headers: { authorization, origin: 'https://attacker.example' },
  });
  assert.equal(foreignOrigin.status, 403);
  assert.equal(JSON.parse(foreignOrigin.body).error.code, 'INVALID_ORIGIN');

  const localOrigin = await rawControlRequest({
    port: control.port,
    headers: { authorization, origin: `http://127.0.0.1:${control.port}` },
  });
  assert.equal(localOrigin.status, 200);
});

test('control plane bounds request rate and concurrent work', async (t) => {
  const { snapshotMetrics } = await import('../src/lib/metrics.mjs');
  const before = snapshotMetrics().counters;
  const rateLimited = new ControlServer({ port: 0, tools: {}, rateLimit: 2, rateWindowMs: 60_000 });
  await rateLimited.start();
  const rateHandshake = await readHandshake();
  const headers = { authorization: `Bearer ${rateHandshake.token}` };
  assert.equal((await rawControlRequest({ port: rateLimited.port, path: "/missing", headers })).status, 404);
  assert.equal((await rawControlRequest({ port: rateLimited.port, path: "/missing", headers })).status, 404);
  const third = await rawControlRequest({ port: rateLimited.port, path: "/missing", headers });
  assert.equal(third.status, 429);
  await rateLimited.stop();

  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const concurrent = new ControlServer({
    port: 0,
    maxConcurrentRequests: 1,
    tools: { wait: async () => { entered(); await held; return true; } },
  });
  await concurrent.start();
  t.after(() => concurrent.stop());
  const concurrentHandshake = await readHandshake();
  const first = callDaemon({ ...concurrentHandshake, tool: 'wait' });
  await started;
  await assert.rejects(
    callDaemon({ ...concurrentHandshake, tool: 'wait' }),
    (error) => error.code === 'CONTROL_BUSY',
  );
  release();
  assert.equal(await first, true);
  assert.equal(snapshotMetrics().counters['control.rate_limited'], (before['control.rate_limited'] ?? 0) + 1);
  assert.equal(snapshotMetrics().counters['control.busy'], (before['control.busy'] ?? 0) + 1);
});

test('health bypasses exhausted rate buckets and general slots', async (t) => {
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const control = new ControlServer({ port: 0, rateLimit: 1, maxConcurrentRequests: 1,
    tools: { hold: async () => { entered(); await held; return true; } } });
  await control.start();
  t.after(() => control.stop());
  const handshake = await readHandshake();
  const pending = callDaemon({ ...handshake, tool: 'hold' });
  await started;
  try {
    assert.equal(await probeDaemon(handshake.controlUrl, handshake.token, 1000), true);
    assert.equal((await rawControlRequest({ port: control.port, headers: { authorization: 'Bearer wrong' } })).status, 401);
  } finally { release(); await pending; }
});

test('rate buckets isolate client ids and preserve legacy address limits', async (t) => {
  const control = new ControlServer({ port: 0, rateLimit: 1, tools: { echo: async (args, context) => context } });
  await control.start(); t.after(() => control.stop());
  const handshake = await readHandshake();
  const first = await callDaemon({ ...handshake, tool: 'echo', client: { client_id: 'client-one', task_id: 'task:1' } });
  assert.equal(first.client_id, 'client-one'); assert.equal(first.task_id, 'task:1');
  await assert.rejects(callDaemon({ ...handshake, tool: 'echo', client: { client_id: 'client-one' } }), { code: 'RATE_LIMITED' });
  assert.equal((await callDaemon({ ...handshake, tool: 'echo', client: { client_id: 'client-two' } })).client_id, 'client-two');
  assert.equal((await callDaemon({ ...handshake, tool: 'echo' })).client_id, 'legacy');
  await assert.rejects(callDaemon({ ...handshake, tool: 'echo' }), { code: 'RATE_LIMITED' });
});

test('long calls have an independent pool and metrics require observe authentication', async (t) => {
  const { snapshotMetrics } = await import('../src/lib/metrics.mjs');
  const before = snapshotMetrics().counters;
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const control = new ControlServer({ port: 0, maxConcurrentRequests: 1, maxLongConcurrentRequests: 1,
    tools: { curl_test: async () => { entered(); await held; return true; }, echo: async () => true,
      wait_for_flow: async () => true, repeat_test: async () => true, request_test: async () => true, setup_host_certificate: async () => true } });
  await control.start(); t.after(() => control.stop());
  const handshake = await readHandshake();
  const pending = callDaemon({ ...handshake, tool: 'curl_test' }); await started;
  try {
    assert.equal(await callDaemon({ ...handshake, tool: 'echo' }), true);
    for (const tool of ['curl_test', 'wait_for_flow', 'repeat_test', 'request_test', 'setup_host_certificate']) {
      await assert.rejects(callDaemon({ ...handshake, tool }), { code: 'CONTROL_LONG_BUSY' });
    }
    assert.equal((await rawControlRequest({ port: control.port, path: '/metrics' })).status, 401);
    const response = await rawControlRequest({ port: control.port, path: '/metrics', headers: { authorization: `Bearer ${handshake.token}` } });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).counters['control.long_busy'], (before['control.long_busy'] ?? 0) + 5);
    assert.ok(response.body.length < 65536);
    control.server.emit('drop');
    assert.equal(snapshotMetrics().counters['control.connections_dropped'], (before['control.connections_dropped'] ?? 0) + 1);
  } finally { release(); await pending; }
});

test('metrics enforce observe scope and bound snapshots, and rate buckets are pruned', async (t) => {
  const { registerGauge } = await import('../src/lib/metrics.mjs');
  const control = new ControlServer({ port: 0, tools: {} });
  await control.start(); t.after(() => control.stop());
  const headers = { authorization: `Bearer ${control.token}` };
  control.scopes.delete('observe');
  assert.equal((await rawControlRequest({ port: control.port, path: '/metrics', headers })).status, 403);
  control.scopes.add('observe');
  const unregister = registerGauge('test.large', () => 'x'.repeat(65536));
  try {
    const response = await rawControlRequest({ port: control.port, path: '/metrics', headers });
    assert.equal(response.status, 503); assert.ok(response.body.length < 4096);
  } finally { unregister(); }
  control.rateBuckets.set('expired', { startedAt: 0, count: 999 });
  await rawControlRequest({ port: control.port, path: '/missing', headers });
  assert.equal(control.rateBuckets.has('expired'), false);
});
