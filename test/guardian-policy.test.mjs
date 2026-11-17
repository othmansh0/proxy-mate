import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createGuardian } from '../src/lib/guardian.mjs';
import { STATE_DIR } from '../src/lib/config.mjs';

function fixture(options = {}) {
  let clock = 0, healthy = false, exists = true;
  let sample = { pid: 123, heartbeat_age_ms: 900, verdict: 'slow', lag_p99_ms: 50, elu: 0.9, progress: { flows_completed: 10 } };
  const signals = [], events = [], logs = [], probes = [], liveProbes = [];
  const expected = path.join(STATE_DIR, 'runtime/build-owned/src/server.mjs');
  const tick = createGuardian({
    read: async () => ({ pid: 123, runtime_role: 'daemon', runtime_entry: expected }),
    readPid: async () => 123, isAlive: () => true,
    handshake: async () => ({ controlUrl: 'local', token: 'fake' }),
    probe: async (...args) => { probes.push(args); return healthy; },
    liveness: async args => { liveProbes.push(args); return sample; },
    livenessExists: async () => exists,
    run: async () => ({ stdout: `/usr/bin/node ${expected} --daemon` }),
    intent: async () => {}, signal: (pid, sig) => signals.push([pid, sig]),
    record: async (event, fields) => events.push({ event, ...fields }),
    log: (...args) => logs.push(args), now: () => clock,
    loadavg: () => [4], cores: () => 4, ...options,
  });
  return { tick, signals, events, logs, probes, liveProbes,
    time: value => { clock = value; }, healthy: value => { healthy = value; },
    sample: value => { sample = value; }, exists: value => { exists = value; } };
}

test('guardian keeps a slow owner for ten minutes with rate-limited diagnostics', async () => {
  const f = fixture();
  for (let ms = 0; ms <= 600000; ms += 3000) { f.time(ms); assert.equal((await f.tick()).action, 'waiting_for_health'); }
  assert.deepEqual(f.signals, []);
  assert.equal(f.events.length, 11); assert.equal(f.logs.length, 11);
  assert.equal(f.events[0].event, 'slow_owner_observed');
  assert.deepEqual(f.events[0].details, { probe_failing_for_ms: 0, heartbeat_age_ms: 900, verdict: 'slow', lag_p99_ms: 50, elu: 0.9, load1: 4, cores: 4, flows_completed: 10, flows_delta: 0 });
  assert.equal(f.logs[0][1], 'slow owner kept');
  assert.deepEqual(f.probes[0], ['local', 'fake', 1000, { client_id: 'guardian-probe' }]);
  assert.equal(f.liveProbes[0].timeoutMs, 750);
});

for (const [load, ceiling] of [[4, 60000], [16, 180000]]) {
  test(`guardian terminates a hung heartbeat at load ${load}`, async () => {
    const f = fixture({ loadavg: () => [load] });
    f.sample({ pid: 123, heartbeat_age_ms: ceiling - 1, progress: { flows_completed: 0 } });
    await f.tick(); assert.equal(f.signals.length, 0);
    f.sample({ pid: 123, heartbeat_age_ms: ceiling, progress: { flows_completed: 0 } });
    assert.equal((await f.tick()).action, 'restart_requested');
    const details = f.events.find(e => e.event === 'terminating_unresponsive_owner').details;
    assert.equal(details.decision, 'hung'); assert.equal(details.hang_ceiling_ms, ceiling);
    assert.equal(details.heartbeat_age_ms, ceiling); assert.equal(details.unreachable_for_ms, 0);
  });
}

for (const previouslySeen of [false, true]) {
  test(`guardian waits 120s at load factor four for ${previouslySeen ? 'previously seen' : 'present'} unreachable liveness`, async () => {
    const f = fixture({ loadavg: () => [16] });
    if (previouslySeen) { await f.tick(); f.exists(false); }
    f.sample(null); f.time(1000); await f.tick();
    f.time(120999); assert.equal((await f.tick()).action, 'waiting_for_health');
    f.time(121000); assert.equal((await f.tick()).action, 'restart_requested');
    assert.equal(f.events.at(-1).details.decision, 'unreachable');
    assert.equal(f.events.at(-1).details.unreachable_for_ms, 120000);
    assert.equal(f.liveProbes.at(-1).timeoutMs, 3000);
    assert.equal(f.probes.at(-1)[2], 4000);
  });
}

test('guardian legacy fallback scales with load and caps probe timeouts', async () => {
  const f = fixture({ loadavg: () => [400] }); f.exists(false); f.sample(null);
  await f.tick(); f.time(119999); assert.equal((await f.tick()).action, 'waiting_for_health');
  f.time(120000); assert.equal((await f.tick()).action, 'restart_requested');
  assert.equal(f.events.at(-1).details.decision, 'legacy_timeout');
  assert.equal(f.probes[0][2], 5000); assert.equal(f.liveProbes[0].timeoutMs, 3000);
});

for (const legacy of [false, true]) {
  test(`guardian success resets ${legacy ? 'legacy' : 'unreachable'} windows`, async () => {
    const f = fixture(); f.sample(null); f.exists(!legacy); await f.tick();
    f.time(29000); f.healthy(true); assert.equal((await f.tick()).action, 'healthy');
    f.time(30000); f.healthy(false); await f.tick();
    f.time(59999); assert.equal((await f.tick()).action, 'waiting_for_health');
    f.time(60000); assert.equal((await f.tick()).action, 'restart_requested');
  });
}

test('guardian progress resets the unreachable window and reports sample deltas', async () => {
  const f = fixture(); await f.tick(); f.sample(null); f.time(1000); await f.tick();
  f.time(29000); f.sample({ pid: 123, heartbeat_age_ms: 900, progress: { flows_completed: 15 } }); await f.tick();
  f.sample(null); f.time(30000); await f.tick();
  f.time(59999); assert.equal((await f.tick()).action, 'waiting_for_health');
  f.time(60000); f.sample({ pid: 123, heartbeat_age_ms: 900, progress: { flows_completed: 20 } }); await f.tick();
  assert.equal(f.events.at(-1).details.flows_delta, 5);
  f.sample(null); f.time(61000); await f.tick(); f.time(91000);
  assert.equal((await f.tick()).action, 'restart_requested');
});

test('guardian retains injectable decision policies', async () => {
  let inputs;
  const f = fixture({ shouldTerminate: value => { inputs = value; return false; } });
  f.sample({ pid: 123, heartbeat_age_ms: 60000 }); await f.tick();
  assert.equal(inputs.decision, 'hung'); assert.deepEqual(f.signals, []);
});

test('guardian slow diagnostics stay rate limited across control recovery', async () => {
  const f = fixture(); await f.tick();
  f.time(1000); f.healthy(true); await f.tick();
  f.time(2000); f.healthy(false); await f.tick();
  assert.equal(f.events.filter(e => e.event === 'slow_owner_observed').length, 1);
  assert.equal(f.logs.length, 1);
  f.time(60000); await f.tick(); assert.equal(f.logs.length, 2);
});

test('guardian ignores liveness belonging to another owner', async () => {
  const f = fixture();
  f.sample({ pid: 456, heartbeat_age_ms: 900 }); await f.tick();
  f.time(30000); assert.equal((await f.tick()).action, 'restart_requested');
  assert.equal(f.events.at(-1).details.decision, 'unreachable');
});
