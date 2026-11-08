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
