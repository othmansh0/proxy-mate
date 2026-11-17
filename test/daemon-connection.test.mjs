import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForReadyDaemon } from '../src/lib/daemon-connection.mjs';

test('readiness wait discovers rotated addresses and tokens before dispatch', async () => {
  let reads = 0;
  const probes = [];
  const ready = await waitForReadyDaemon({ timeoutMs: 1000,
    read: async () => ++reads < 3 ? { controlUrl: 'http://127.0.0.1:1', token: 'old' }
      : { controlUrl: 'http://127.0.0.1:2', token: 'new' },
    probe: async (url, token) => { probes.push({ url, token }); return token === 'new'; },
  });
  assert.equal(ready.token, 'new');
  assert.equal(probes.length, 3);
});

test('initial single probe has a usable deadline without enabling a reconnect wait', async () => {
  let calls = 0;
  assert.equal(await waitForReadyDaemon({ read: async () => ({ controlUrl: 'local', token: 'token' }),
    probe: async (_url, _token, deadline) => { calls++; assert.equal(deadline, 1500); return false; },
  }), null);
  assert.equal(calls, 1);
});

test('readiness deadline returns unavailable without creating a local owner', async () => {
  const start = Date.now();
  assert.equal(await waitForReadyDaemon({ timeoutMs: 40, read: async () => null }), null);
  assert.ok(Date.now() - start < 1000);
});

test('cancellation interrupts the reconnect delay', async () => {
  const controller = new AbortController();
  const pending = waitForReadyDaemon({ timeoutMs: 10_000, signal: controller.signal, read: async () => null });
  controller.abort(new Error('cancelled by client'));
  await assert.rejects(pending, { code: 'REQUEST_CANCELLED' });
});

test('successful RPC caches readiness for two seconds only for the same handshake', async () => {
  const { createDaemonReadiness } = await import('../src/lib/daemon-connection.mjs');
  let now = 0, probes = 0;
  let handshake = { controlUrl: 'local', token: 'one' };
  const readiness = createDaemonReadiness({ now: () => now, read: async () => handshake,
    probe: async () => { probes++; return true; } });
  await readiness.waitForReady(); assert.equal(probes, 1);
  readiness.recordSuccess(handshake);
  now = 1999; await readiness.waitForReady(); assert.equal(probes, 1);
  now = 2000; await readiness.waitForReady(); assert.equal(probes, 2);
  readiness.recordSuccess(handshake);
  handshake = { controlUrl: 'local', token: 'two' };
  await readiness.waitForReady(); assert.equal(probes, 3);
});

test('outage backoff doubles with bounded jitter and respects its deadline', async () => {
  let now = 0;
  const delays = [];
  assert.equal(await waitForReadyDaemon({ timeoutMs: 4000, now: () => now, random: () => 0.5,
    delay: async (ms) => { delays.push(ms); now += ms; }, read: async () => null }), null);
  assert.deepEqual(delays, [100, 200, 400, 800, 1000, 1000, 500]);
  now = 0; delays.length = 0;
  await waitForReadyDaemon({ timeoutMs: 400, now: () => now, random: () => 0,
    delay: async (ms) => { delays.push(ms); now += ms; }, read: async () => null });
  assert.deepEqual(delays, [80, 160, 160]);
});

test('cached readiness still honors cancellation while reading the handshake', async () => {
  const { createDaemonReadiness } = await import('../src/lib/daemon-connection.mjs');
  const controller = new AbortController();
  const handshake = { token: 'same', controlUrl: 'local' };
  const readiness = createDaemonReadiness({ now: () => 1, read: async () => { controller.abort(); return handshake; } });
  readiness.recordSuccess(handshake);
  await assert.rejects(readiness.waitForReady({ signal: controller.signal }), { code: 'REQUEST_CANCELLED' });
});
