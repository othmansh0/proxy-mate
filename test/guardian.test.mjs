import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createGuardian, terminateOwnedDaemon } from '../src/lib/guardian.mjs';
import { STATE_DIR } from '../src/lib/config.mjs';

test('guardian preserves a healthy daemon and transient health failures', async () => {
  let clock = 0, healthy = false, stopped = 0;
  const tick = createGuardian({ read: async () => ({ pid: 123, runtime_role: 'daemon' }), readPid: async () => 123,
    isAlive: () => true, handshake: async () => ({ controlUrl: 'local', token: 'test' }), probe: async () => healthy,
    now: () => clock, terminate: async () => { stopped++; return true; }, record: async () => {} });
  assert.equal((await tick()).action, 'waiting_for_health');
  clock = 29000; assert.equal((await tick()).action, 'waiting_for_health');
  healthy = true; assert.equal((await tick()).action, 'healthy');
  healthy = false; clock = 60000; assert.equal((await tick()).action, 'waiting_for_health');
  assert.equal(stopped, 0);
  clock = 91000; assert.equal((await tick()).action, 'restart_requested');
  assert.equal(stopped, 1);
});

test('guardian recovers dead routing under exclusive ownership and preserves a replacement owner', async () => {
  let reads = 0, restored = 0, released = 0;
  const base = { pid: 123, runtime_role: 'daemon', routing_active: true };
  const deps = { read: async () => { reads++; return base; }, isAlive: () => false,
    acquire: async ({ wait }) => { assert.equal(wait, false); return async () => { released++; }; },
    restore: async ({ recoverStale }) => { assert.equal(recoverStale, true); restored++; }, record: async () => {} };
  assert.equal((await createGuardian(deps)()).action, 'dead_owner_recovered');
  assert.equal(restored, 1); assert.equal(released, 1);
  reads = 0;
  const changed = createGuardian({ ...deps, read: async () => ++reads === 1 ? base : { ...base, pid: 456 } });
  assert.equal((await changed()).action, 'owner_changed'); assert.equal(restored, 1);
});

test('guardian does not fight a runtime lock or a daemon still starting', async () => {
  const state = { pid: 123, runtime_role: 'daemon' };
  const tick = createGuardian({ read: async () => state, isAlive: () => false,
    acquire: async () => { throw Object.assign(new Error(), { code: 'RUNTIME_BUSY' }); } });
  assert.equal((await tick()).action, 'waiting_for_owner');
  const startup = createGuardian({ read: async () => state, isAlive: () => true, readPid: async () => 1 });
  assert.equal((await startup()).action, 'startup_in_progress');
});

test('guardian refuses a reused PID or unrelated server, even if its name is server.mjs', async () => {
  let signals = 0;
  const expected = path.join(STATE_DIR, 'runtime/build-owned/src/server.mjs');
  const deps = { readPid: async () => 123,
    state: async () => ({ pid: 123, runtime_role: 'daemon', runtime_entry: expected }),
    run: async () => ({ stdout: '/usr/bin/node /some/other/server.mjs --daemon' }),
    signal: () => { signals++; }, isAlive: () => false };
  assert.equal(await terminateOwnedDaemon(123, deps), false); assert.equal(signals, 0);
  assert.equal(await terminateOwnedDaemon(123, { ...deps, run: async () => ({ stdout: `/usr/bin/node ${expected} --daemon` }) }), true);
  assert.equal(signals, 1);
});
