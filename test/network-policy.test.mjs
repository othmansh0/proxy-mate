import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { connectionAttemptTimeout, configureConnectionAttempts } from '../src/lib/network-policy.mjs';

test('connection attempt configuration rejects invalid values without changing the process policy', () => {
  const before = net.getDefaultAutoSelectFamilyAttemptTimeout();
  for (const value of ['', 'bad', '0', '-1', '9', '10001', '2.5', 'Infinity', '2000 trailing']) {
    assert.throws(() => configureConnectionAttempts({ PROXYFAN_CONNECT_ATTEMPT_TIMEOUT_MS: value }), {
      code: 'INVALID_CONNECT_ATTEMPT_TIMEOUT',
    });
    assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), before);
  }
  assert.equal(connectionAttemptTimeout({}), 2000);
  assert.equal(connectionAttemptTimeout({ PROXYFAN_CONNECT_ATTEMPT_TIMEOUT_MS: '1500' }), 1500);
});

test('the default policy preserves a viable dual-stack connection across a delayed I/O turn', { timeout: 15000 }, async (t) => {
  const before = net.getDefaultAutoSelectFamilyAttemptTimeout();
  t.after(() => net.setDefaultAutoSelectFamilyAttemptTimeout(before));
  const server = net.createServer((socket) => {
    socket.on('error', () => {}); // The short policy deliberately aborts a viable connection.
    socket.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const outcomes = [];
  for (const timeout of [250, undefined]) {
    configureConnectionAttempts(timeout === undefined ? {} : { PROXYFAN_CONNECT_ATTEMPT_TIMEOUT_MS: String(timeout) });
    assert.equal(net.getDefaultAutoSelectFamily(), true);
    assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), timeout ?? 2000);
    const socket = new net.Socket();
    try {
      await new Promise((resolve) => setImmediate(resolve));
      const result = new Promise((resolve) => {
        socket.once('connect', () => resolve('connected'));
        socket.once('connectionAttemptTimeout', (address, _port, family) => resolve({ event: 'connectionAttemptTimeout', address, family }));
        socket.once('error', (error) => resolve(error));
        socket.setTimeout(5000, () => socket.destroy(new Error('Fixture deadline exceeded.')));
        socket.connect({ host: 'fixture.invalid', port: server.address().port,
          lookup: (_host, _options, callback) => callback(null, [
            { address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 },
          ]),
        });
      });
      // Delay the check phase until the short attempt timer expires, before I/O
      // completes in the next poll. Full listen backlogs reset sockets on macOS.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
      outcomes.push(await result);
    } finally {
      socket.destroy();
    }
  }
  assert.deepEqual(outcomes[0], { event: 'connectionAttemptTimeout', address: '127.0.0.1', family: 4 });
  assert.equal(outcomes[1], 'connected');
});
