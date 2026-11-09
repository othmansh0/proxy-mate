import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { connectionAttemptTimeout, configureConnectionAttempts } from '../src/lib/network-policy.mjs';

test('connection attempt configuration rejects invalid values without changing the process policy', () => {
  const before = net.getDefaultAutoSelectFamilyAttemptTimeout();
  for (const value of ['', 'bad', '0', '-1', '9', '10001', '2.5', 'Infinity', '2000 trailing']) {
    assert.throws(() => configureConnectionAttempts({ PROXY_MCP_CONNECT_ATTEMPT_TIMEOUT_MS: value }), {
      code: 'INVALID_CONNECT_ATTEMPT_TIMEOUT',
    });
    assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), before);
  }
  assert.equal(connectionAttemptTimeout({}), 2000);
  assert.equal(connectionAttemptTimeout({ PROXY_MCP_CONNECT_ATTEMPT_TIMEOUT_MS: '1500' }), 1500);
});

test('a slow viable connection survives the default policy with both address families enabled', { timeout: 15000 }, async (t) => {
  const before = net.getDefaultAutoSelectFamilyAttemptTimeout();
  t.after(() => net.setDefaultAutoSelectFamilyAttemptTimeout(before));
  const outcomes = [];
  for (const timeout of [250, undefined]) {
    const sockets = new Set();
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import net from 'node:net';
      const server = net.createServer(socket => socket.resume());
      server.listen({ host: '127.0.0.1', port: 0, backlog: 1 }, () => {
        process.stdout.write(String(server.address().port) + '\\n');
        process.kill(process.pid, 'SIGSTOP');
      });
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => {
      for (const socket of sockets) socket.destroy();
      child.kill('SIGCONT');
      child.kill('SIGKILL');
    });
    const exited = once(child, 'exit');
    let resume;
    try {
      const [data] = await once(child.stdout, 'data');
      const port = Number(data.toString().trim());
      assert.ok(port > 0);
      let saturated = false;
      for (let index = 0; index < 32; index += 1) {
        const socket = new net.Socket();
        sockets.add(socket);
        const connected = await new Promise((resolve, reject) => {
          socket.once('connect', () => { socket.setTimeout(0); resolve(true); });
          socket.once('error', reject);
          socket.setTimeout(50, () => { socket.destroy(); resolve(false); });
          socket.connect(port, '127.0.0.1');
        });
        if (!connected) { saturated = true; break; }
      }
      assert.equal(saturated, true, 'The fixture must delay TCP connections before testing the policy.');
      configureConnectionAttempts(timeout === undefined ? {} : { PROXY_MCP_CONNECT_ATTEMPT_TIMEOUT_MS: String(timeout) });
      assert.equal(net.getDefaultAutoSelectFamily(), true);
      resume = setTimeout(() => child.kill('SIGCONT'), 600);
      const socket = new net.Socket();
      sockets.add(socket);
      const result = await new Promise((resolve) => {
        socket.once('connect', () => resolve('connected'));
        socket.once('error', (error) => resolve(error));
        socket.setTimeout(5000, () => socket.destroy(new Error('Fixture deadline exceeded.')));
        socket.connect({ host: 'fixture.invalid', port,
          lookup: (_host, _options, callback) => callback(null, [
            { address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 },
          ]),
        });
      });
      outcomes.push(result);
    } finally {
      clearTimeout(resume);
      for (const socket of sockets) socket.destroy();
      child.kill('SIGCONT');
      child.kill('SIGTERM');
      await exited;
    }
  }
  assert.ok(outcomes[0] instanceof AggregateError);
  assert.ok(outcomes[0].errors.some((error) => error.code === 'ETIMEDOUT'));
  assert.equal(outcomes[1], 'connected');
});
