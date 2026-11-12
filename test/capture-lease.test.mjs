import test from 'node:test';
import assert from 'node:assert/strict';
import { CaptureLease, rememberCaptureLease } from '../src/lib/capture-lease.mjs';

test('leases exclude other mutations, survive a new manager, expire, and never expose their ID through status/errors', async () => {
  let state = {}, now = 1000;
  const options = { read: async () => structuredClone(state), patch: async (value) => { state = { ...state, ...value }; }, clock: () => now };
  const lease = new CaptureLease(options);
  const acquired = await lease.acquire({ task_id: 'task-a', ttl_seconds: 30 });
  assert.equal((await lease.assert(acquired.capture_lease_id)).task_id, 'task-a');
  assert.equal(lease.status(state).active, true);
  assert.ok(!JSON.stringify(lease.status(state)).includes(acquired.capture_lease_id));
  await assert.rejects(lease.assert(), (error) => error.code === 'CAPTURE_OWNED' && !JSON.stringify(error.details).includes(acquired.capture_lease_id));
  await assert.rejects(lease.acquire({ task_id: 'task-b' }), { code: 'CAPTURE_OWNED' });
  const restored = new CaptureLease(options);
  await assert.rejects(restored.release({}), { code: 'CAPTURE_OWNED' });
  const renewed = await restored.acquire({ task_id: 'task-a', capture_lease_id: acquired.capture_lease_id, ttl_seconds: 60 });
  assert.equal(renewed.capture_lease_id, acquired.capture_lease_id);
  now += 60_001;
  await assert.rejects(restored.assert(acquired.capture_lease_id), { code: 'CAPTURE_LEASE_EXPIRED' });
  const next = await restored.acquire({ task_id: 'task-b', ttl_seconds: 30 });
  assert.notEqual(next.capture_lease_id, acquired.capture_lease_id);
  assert.equal((await restored.release({ capture_lease_id: next.capture_lease_id })).capture_continues, true);
  assert.equal(state.capture_lease, null);
});

test('two simultaneous acquisitions cannot both succeed', async () => {
  let state = {};
  const lease = new CaptureLease({ read: async () => state, patch: async (value) => { state = { ...state, ...value }; } });
  const results = await Promise.allSettled(['one', 'two'].map((task_id) => lease.acquire({ task_id })));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'CAPTURE_OWNED');
});

test('explicit reacquisition retains task resources after an expiry error without retrying the mutation', async () => {
  let state = {}, now = 1000, mutations = 0;
  const lease = new CaptureLease({ read: async () => structuredClone(state),
    patch: async (value) => { state = { ...state, ...value }; }, clock: () => now });
  const bridge = rememberCaptureLease(async (tool, args) => {
    if (tool === 'acquire_capture_lease') return lease.acquire(args);
    if (tool === 'release_capture_lease') return lease.release(args);
    mutations += 1;
    return lease.assert(args.capture_lease_id);
  });
  const first = await bridge('acquire_capture_lease', { task_id: 'task', ttl_seconds: 30 });
  await lease.trackResource(first.capture_lease_id, { kind: 'rule', id: 'fixture', revision: 'one' });
  now += 30_001;
  await assert.rejects(bridge('remove_rule', { rule_id: 'fixture' }), { code: 'CAPTURE_LEASE_EXPIRED' });
  assert.equal(mutations, 1);
  const renewed = await bridge('acquire_capture_lease', { task_id: 'task' });
  assert.notEqual(renewed.capture_lease_id, first.capture_lease_id);
  assert.equal(state.capture_lease.resources[0].id, 'fixture');
  await bridge('release_capture_lease');
  await bridge('acquire_capture_lease', { task_id: 'other' });
  assert.deepEqual(state.capture_lease.resources, []);
});

test('a bridge remembers only its own explicitly acquired lease and never retries mutations', async () => {
  const calls = [];
  const bridge = rememberCaptureLease(async (tool, args) => {
    calls.push({ tool, args });
    return tool === 'acquire_capture_lease' ? { capture_lease_id: 'local-lease' } : {};
  });
  await bridge('acquire_capture_lease', { task_id: 'task' });
  await bridge('mock_json_response', { rule_id: 'task-fixture' });
  await bridge('resolve_breakpoint', { breakpoint_id: 'pause' });
  await bridge('get_flows', {});
  await bridge('release_capture_lease', {});
  await bridge('stop_proxy', {});
  assert.equal(calls[1].args.capture_lease_id, 'local-lease');
  assert.equal(calls[2].args.capture_lease_id, 'local-lease');
  assert.equal(calls[3].args.capture_lease_id, undefined);
  assert.equal(calls[4].args.capture_lease_id, 'local-lease');
  assert.equal(calls[5].args.capture_lease_id, undefined);
  let failures = 0;
  await assert.rejects(rememberCaptureLease(async () => { failures += 1; throw new Error('ambiguous'); })('stop_proxy', {}));
  assert.equal(failures, 1);
});
