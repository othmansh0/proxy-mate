import test from 'node:test';
import assert from 'node:assert/strict';
import { CaptureLease, rememberCaptureLease } from '../src/lib/capture-lease.mjs';

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
