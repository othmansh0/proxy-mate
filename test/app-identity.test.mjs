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
          assert.ok(args.includes('-iTCP:8080'));
          return { stdout: 'p200\nn127.0.0.1:50000->127.0.0.1:8080\n' };
        }
        assert.equal(file, '/bin/ps');
        assert.deepEqual(args, ['-p', '200', '-o', 'comm=']);
        return { stdout: executable };
      } });
    assert.equal(await classify({ remoteAddress: '127.0.0.1', remotePort: 50000, localPort: 8080 }), expected);
  }
});

test('a burst shares a fresh socket snapshot and process verification instead of dropping the 17th connection', async () => {
  let socketLookups = 0, processChecks = 0;
  const classify = createAppClassifier({ appPath: '/sim/Selected.app', realpath: async (value) => value,
    verifyProcess: async () => { processChecks += 1; return true; },
    execute: async (file) => {
      if (file === '/usr/sbin/lsof') {
        socketLookups += 1;
        return { stdout: 'p200\n' + Array.from({ length: 64 }, (_, i) => `n127.0.0.1:${50000 + i}->127.0.0.1:8083\n`).join('') };
      }
      return { stdout: '/sim/Selected.app/Selected' };
    } });
  const result = await Promise.all(Array.from({ length: 64 }, (_, i) => classify({ remoteAddress: '127.0.0.1', remotePort: 50000 + i, localPort: 8083 })));
  assert.ok(result.every((value) => value === 'selected'));
  assert.equal(socketLookups, 1);
  assert.equal(processChecks, 1);
  assert.equal(classify.status().pending, 0);
  assert.equal(classify.status().coverage, 'observed');
  await classify({ remoteAddress: '127.0.0.1', remotePort: 50000, localPort: 8083 });
  assert.equal(socketLookups, 2, 'later connections must not reuse stale port ownership');
  assert.equal(processChecks, 2, 'PID identity must not outlive a socket batch');
});

test('reinstall refreshes the bundle path only for a positively verified selected Simulator process', async () => {
  let refreshes = 0;
  for (const allowed of [true, false]) {
    const classify = createAppClassifier({ appPath: '/sim/old/Selected.app',
      resolveAppPath: async () => { refreshes += 1; return '/sim/new/Selected.app'; },
      verifyProcess: async () => allowed, realpath: async (value) => {
        if (value === '/sim/old/Selected.app') throw Object.assign(new Error('Removed container'), { code: 'ENOENT' });
        return value;
      },
      execute: async (file) => ({ stdout: file === '/usr/sbin/lsof'
        ? 'p200\nn127.0.0.1:50000->127.0.0.1:8083\n' : '/sim/new/Selected.app/Selected' }) });
    assert.equal(await classify({ remoteAddress: '127.0.0.1', remotePort: 50000, localPort: 8083 }), allowed ? 'selected' : 'other');
  }
  assert.equal(refreshes, 1);
});

test('bounded attribution overload is visible and never grants inspection', async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const classify = createAppClassifier({ appPath: '/sim/Selected.app', maxPending: 2,
    execute: async () => { await waiting; throw new Error('fixture timeout'); } });
  const socket = { remoteAddress: '127.0.0.1', remotePort: 50000, localPort: 8083 };
  const pending = [classify(socket), classify(socket)];
  assert.equal(await classify(socket), 'unknown');
  release();
  assert.deepEqual(await Promise.all(pending), ['unknown', 'unknown']);
  assert.equal(classify.status().coverage, 'degraded');
  assert.equal(classify.status().unknown_reasons.queue_full, 1);
  assert.equal(classify.status().unknown_reasons.socket_lookup_failed, 2);
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
