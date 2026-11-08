import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.PROXY_MCP_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-mcp-control-'));
const { ControlServer, probeDaemon, callDaemon } = await import('../src/lib/control.mjs');
const { readHandshake } = await import('../src/lib/state.mjs');

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
  assert.deepEqual(await callDaemon({ ...handshake, tool: 'echo', args: { ok: 1 } }), { ok: 1 });
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
  const rateLimited = new ControlServer({ port: 0, tools: {}, rateLimit: 2, rateWindowMs: 60_000 });
  await rateLimited.start();
  const rateHandshake = await readHandshake();
  const headers = { authorization: `Bearer ${rateHandshake.token}` };
  assert.equal((await rawControlRequest({ port: rateLimited.port, headers })).status, 200);
  assert.equal((await rawControlRequest({ port: rateLimited.port, headers })).status, 200);
  const third = await rawControlRequest({ port: rateLimited.port, headers });
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
});
