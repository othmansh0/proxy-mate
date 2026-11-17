import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createGuardian, terminateOwnedDaemon } from '../src/lib/guardian.mjs';
import { STATE_DIR } from '../src/lib/config.mjs';

test('guardian preserves a healthy daemon and transient health failures', async () => {
  let clock = 0, healthy = false, stopped = 0;
  const expected = path.join(STATE_DIR, 'runtime/build-owned/src/server.mjs');
  const tick = createGuardian({ read: async () => ({ pid: 123, runtime_role: 'daemon', runtime_entry: expected }), readPid: async () => 123,
    isAlive: () => true, handshake: async () => ({ controlUrl: 'local', token: 'test' }), probe: async () => healthy,
    loadavg: () => [0], cores: () => 4, liveness: async () => null, livenessExists: async () => false,
    now: () => clock, signal: () => { stopped++; }, intent: async () => {},
    run: async () => ({ stdout: `/usr/bin/node ${expected} --daemon` }), record: async () => {} });
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

function fixture(overrides = {}) {
  let clock = 0, live = true;
  const signals = [], events = [], order = [], logs = [];
  const expected = path.join(STATE_DIR, 'runtime/build-owned/src/server.mjs');
  const deps = {
    read: async () => ({ pid: 123, runtime_role: 'daemon', runtime_entry: expected }),
    readPid: async () => 123, isAlive: () => live,
    handshake: async () => null, probe: async () => false,
    liveness: async () => null, livenessExists: async () => false,
    // WP4 tests isolate termination mechanics from the load-scaled WP10 policy.
    shouldTerminate: ({ failingForMs }) => failingForMs >= 30000,
    run: async () => ({ stdout: `/usr/bin/node ${expected} --daemon` }),
    signal: (pid, sig) => { order.push(sig); signals.push([pid, sig]); },
    intent: async (value) => { order.push('intent'); assert.deepEqual(value, { targetPid: 123, reason: 'guardian_health_timeout', by: 'guardian' }); },
    record: async (event, fields) => { order.push(event); events.push({ event, ...fields }); },
    log: (...args) => logs.push(args), now: () => clock, loadavg: () => [8], cores: () => 4,
    ...overrides,
  };
  return { tick: createGuardian(deps), deps, signals, events, order, logs,
    time: (value) => { clock = value; }, gone: () => { live = false; } };
}

test('guardian termination spans ticks, writes intent first and waits 25 seconds before killing', async () => {
  const f = fixture();
  await f.tick(); f.time(30000);
  assert.equal((await f.tick()).action, 'restart_requested');
  assert.deepEqual(f.order, ['intent', 'terminating_unresponsive_owner', 'SIGTERM']);
  assert.deepEqual(f.events[0].details, { failing_for_ms: 30000, decision: 'legacy_timeout', heartbeat_age_ms: null, unreachable_for_ms: 0, load1: 8, cores: 4, hang_ceiling_ms: 120000, probe_timeout_ms: 2000 });
  f.time(54999); assert.equal((await f.tick()).action, 'waiting_for_exit');
  assert.equal(f.signals.length, 1);
  f.time(55000); assert.equal((await f.tick()).action, 'kill_requested');
  assert.deepEqual(f.signals, [[123, 'SIGTERM'], [123, 'SIGKILL']]);
  await f.tick(); assert.equal(f.signals.length, 2);
  f.gone(); f.time(56000);
  assert.equal((await f.tick()).action, 'owner_exited');
  assert.equal(f.events.at(-1).event, 'restarted_unresponsive_owner');
  assert.equal(f.events.at(-1).details.exit_wait_ms, 26000);
});

test('guardian retries ps timeouts with scaled budgets and rate-limited step events', async () => {
  let timeout, failing = true;
  const f = fixture({ run: async (_file, _args, options) => {
    timeout = options.timeout;
    if (failing) throw Object.assign(new Error('ps timed out'), { code: null, killed: true, signal: 'SIGTERM' });
    return { stdout: `/usr/bin/node ${path.join(STATE_DIR, 'runtime/build-owned/src/server.mjs')} --daemon` };
  } });
  await f.tick(); f.time(30000);
  assert.deepEqual(await f.tick(), { action: 'step_failed', step: 'verify' });
  assert.equal(timeout, 4000);
  assert.equal(f.logs[0][2].error_code, 'GUARDIAN_VERIFY_TIMEOUT');
  assert.equal(f.logs[0][2].error_message, 'ps timed out');
  await f.tick(); assert.equal(f.events.filter(e => e.event === 'guardian_step_failed').length, 1);
  failing = false; assert.equal((await f.tick()).action, 'restart_requested');
});

for (const race of ['ESRCH', 'ps_exit_1', 'empty_ps']) {
  test(`guardian treats ${race} as an exited owner`, async () => {
    const g = fixture({
      run: async () => {
        if (race === 'ps_exit_1') throw Object.assign(new Error('gone'), { code: 1 });
        return { stdout: race === 'empty_ps' ? '' : `/usr/bin/node ${path.join(STATE_DIR, 'runtime/build-owned/src/server.mjs')} --daemon` };
      },
      signal: () => { if (race === 'ESRCH') throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
    });
    await g.tick(); g.time(30000); await g.tick();
    assert.equal(g.events.at(-1).event, 'restarted_unresponsive_owner');
    assert.equal(g.events.at(-1).details.exit_wait_ms, 0);
  });
}

for (const failingStep of ['intent', 'record', 'signal']) {
  test(`guardian retries ${failingStep} failure without resetting the health window`, async () => {
    let fail = true;
    const f = fixture({
      [failingStep]: async () => { if (fail) throw new Error(`${failingStep} unavailable`); },
    });
    await f.tick(); f.time(30000);
    assert.deepEqual(await f.tick(), { action: 'step_failed', step: failingStep });
    fail = false;
    assert.equal((await f.tick()).action, 'restart_requested');
  });
}

test('guardian does not resend SIGKILL when journaling fails after the signal', async () => {
  let fail = true;
  const f = fixture({ record: async (event) => {
    if (event === 'killed_unresponsive_owner' && fail) throw new Error('journal unavailable');
  } });
  await f.tick(); f.time(30000); await f.tick(); f.time(55000);
  assert.deepEqual(await f.tick(), { action: 'step_failed', step: 'record' });
  fail = false; await f.tick(); await f.tick();
  assert.deepEqual(f.signals, [[123, 'SIGTERM'], [123, 'SIGKILL']]);
});

test('guardian retries an exit record after state disappears', async () => {
  let fail = false;
  const f = fixture({ record: async (event) => {
    if (fail && event === 'restarted_unresponsive_owner') throw new Error('journal unavailable');
  } });
  await f.tick(); f.time(30000); await f.tick(); f.gone(); fail = true;
  assert.deepEqual(await f.tick(), { action: 'step_failed', step: 'record' });
  fail = false; assert.equal((await f.tick()).action, 'owner_exited');
});

test('guardian verifies again before escalation and preserves a reused PID', async () => {
  let reused = false;
  const f = fixture({ run: async () => ({ stdout: reused ? '/usr/bin/node /other/server.mjs --daemon' :
    `/usr/bin/node ${path.join(STATE_DIR, 'runtime/build-owned/src/server.mjs')} --daemon` }) });
  await f.tick(); f.time(30000); await f.tick(); reused = true; f.time(55000);
  assert.equal((await f.tick()).action, 'unverified_owner_preserved');
  assert.deepEqual(f.signals, [[123, 'SIGTERM']]);
});

test('guardian scales verification timeout with a 10 second ceiling', async () => {
  const f = fixture({ loadavg: () => [1000], cores: () => 4,
    run: async (_file, _args, options) => { assert.equal(options.timeout, 10000); return { stdout: '' }; } });
  await f.tick(); f.time(30000); assert.equal((await f.tick()).action, 'owner_exited');
});

for (const race of ['ESRCH', 'ps_exit_1']) {
  test(`guardian handles ${race} after SIGTERM while escalating`, async () => {
    let escalate = false;
    const f = fixture({
      run: async () => {
        if (escalate && race === 'ps_exit_1') throw Object.assign(new Error('gone'), { code: 1 });
        return { stdout: `/usr/bin/node ${path.join(STATE_DIR, 'runtime/build-owned/src/server.mjs')} --daemon` };
      },
      signal: (_pid, sig) => {
        if (sig === 'SIGKILL' && race === 'ESRCH') throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      },
    });
    await f.tick(); f.time(30000); await f.tick(); escalate = true; f.time(55000);
    assert.equal((await f.tick()).action, 'owner_exited');
    assert.equal(f.events.at(-1).event, 'restarted_unresponsive_owner');
    assert.equal(f.events.at(-1).details.exit_wait_ms, 25000);
  });
}

for (const failingStep of ['read', 'restore']) {
  test(`guardian catches ${failingStep} failures and retries dead-owner recovery`, async () => {
    let fail = true, released = 0;
    const f = fixture({
      read: async () => {
        if (fail && failingStep === 'read') throw new Error('read unavailable');
        return { pid: 123, runtime_role: 'daemon', routing_active: true };
      }, isAlive: () => false,
      acquire: async () => async () => { released++; },
      restore: async () => { if (fail && failingStep === 'restore') throw new Error('restore unavailable'); },
    });
    assert.deepEqual(await f.tick(), { action: 'step_failed', step: failingStep });
    if (failingStep === 'restore') assert.equal(released, 1);
    fail = false; assert.equal((await f.tick()).action, 'dead_owner_recovered');
  });
}

test('guardian step failure events are rate limited per step for 60 seconds', async () => {
  const f = fixture({ read: async () => { throw new Error('read unavailable'); } });
  await f.tick(); f.time(59999); await f.tick();
  assert.equal(f.events.length, 1);
  f.time(60000); await f.tick(); assert.equal(f.events.length, 2);
  assert.equal(f.events[0].details.step, 'read');
  assert.equal(f.events[0].details.error_message, 'read unavailable');
  assert.equal(f.events[0].details.elapsed_ms, 0);
  assert.equal(f.events[0].details.load1, 8);
});
