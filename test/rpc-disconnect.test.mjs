import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { callDaemon } from '../src/lib/control.mjs';

test('a connection lost after a mutation is accepted never retries or advertises safe retry', async (t) => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      calls++;
      // Send a partial envelope, then simulate the daemon dying after commit.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"ok":true,"result":');
      setImmediate(() => res.destroy());
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const controlUrl = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(callDaemon({ controlUrl, token: 'test', tool: 'create_capture_session', args: { name: 'once' } }), (error) => {
    assert.equal(error.code, 'DAEMON_DISCONNECTED');
    assert.equal(error.retryable, false);
    assert.equal(error.details.completion_unknown, true);
    return true;
  });
  assert.equal(calls, 1);
  await assert.rejects(callDaemon({ controlUrl, token: 'test', tool: 'get_proxy_status' }), (error) => {
    assert.equal(error.retryable, true);
    assert.equal(error.details.completion_unknown, false);
    return true;
  });
  assert.equal(calls, 2);
});
