import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppClassifier, findConnectionOwner } from '../src/lib/app-identity.mjs';

test('socket ownership uses the exact client-to-proxy connection rather than the proxy process', () => {
  const output = 'p100\nn127.0.0.1:8080->127.0.0.1:50000\np200\nn127.0.0.1:50000->127.0.0.1:8080\n';
  assert.equal(findConnectionOwner(output, 50000, 8080), 200);
  assert.equal(findConnectionOwner(output, 50001, 8080), null);
});

test('app classification verifies executable containment inside the selected app bundle', async () => {
  for (const [executable, expected] of [
    ['/sim/Selected.app/Selected', 'selected'],
    ['/sim/Selected.app.evil/Selected', 'other'],
    ['/other-sim/Selected.app/Selected', 'other'],
  ]) {
    const classify = createAppClassifier({ appPath: '/sim/Selected.app', realpath: async (value) => value,
      execute: async (file, args, options) => {
        assert.ok(options.timeout <= 2000);
        if (file === '/usr/sbin/lsof') {
          assert.ok(args.includes('-iTCP:50000'));
          return { stdout: 'p200\nn127.0.0.1:50000->127.0.0.1:8080\n' };
        }
        assert.equal(file, '/bin/ps');
        assert.deepEqual(args, ['-p', '200', '-o', 'comm=']);
        return { stdout: executable };
      } });
    assert.equal(await classify({ remoteAddress: '127.0.0.1', remotePort: 50000, localPort: 8080 }), expected);
  }
});

test('unavailable attribution or a non-loopback client never grants inspection', async () => {
  const classify = createAppClassifier({ appPath: '/sim/Selected.app', execute: async () => { throw new Error('Not permitted'); } });
  assert.equal(await classify({ remoteAddress: '127.0.0.1', remotePort: 50000, localPort: 8080 }), 'unknown');
  assert.equal(await classify({ remoteAddress: '192.0.2.1', remotePort: 50000, localPort: 8080 }), 'unknown');
});

test('a process from a different Simulator cannot be inspected even with the same bundle path', async () => {
  const classify = createAppClassifier({ appPath: '/runtime/Safari.app',
    verifyProcess: async () => false, realpath: async () => assert.fail('Process from another Simulator'),
    execute: async () => ({ stdout: 'p200\nn127.0.0.1:50000->127.0.0.1:8083\n' }),
  });
  assert.equal(await classify({ remoteAddress: '127.0.0.1', remotePort: 50000, localPort: 8083 }), 'other');
});
