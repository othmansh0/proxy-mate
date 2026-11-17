import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CaptureLease } from '../src/lib/capture-lease.mjs';
import { createClientRegistry } from '../src/lib/client-registry.mjs';

const a = { client_id: 'client-aaaa', task_id: 'a' }, b = { client_id: 'client-bbbb', task_id: 'b' };
async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-leases-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let now = 100000;
  const registry = createClientRegistry({ now: () => now, intervalMs: 1000, missedBeats: 3, startupGraceMs: 0 });
  const events = [];
  const options = { directory, registry, clock: () => now, read: async () => null, recordEvent: async (...args) => events.push(args) };
  const leases = new CaptureLease(options);
  return { directory, registry, leases, options, events, advance: n => { now += n; } };
}
test('independent tasks acquire and mutate independently; live ownership conflicts and presence loss orphans', async t => {
  const { leases, registry, advance, events } = await setup(t);
  registry.touch(a); registry.touch(b);
  const [la, lb] = await Promise.all([leases.acquire({ task_id: 'a' }, a), leases.acquire({ task_id: 'b' }, b)]);
  await leases.trackResource(lb.capture_lease_id, { kind: 'rule', id: 'b-rule', revision: '1' });
  assert.equal((await leases.assert(la.capture_lease_id, a, [{ kind: 'rule', id: 'a-rule' }])).task_id, 'a');
  await assert.rejects(leases.assert(la.capture_lease_id, a, [{ kind: 'rule', id: 'b-rule' }]), { code: 'CAPTURE_OWNED' });
  advance(4000); registry.touch(a); await registry.sweep();
  await leases.assert(la.capture_lease_id, a, [{ kind: 'rule', id: 'b-rule' }]);
  const status = await leases.summary(b);
  assert.equal(status.orphaned_resource_count, 1);
  assert.equal(status.orphaned_resources[0].id, 'b-rule');
  assert.equal((await leases.summary(a)).orphaned_resources.length, 0);
  assert.ok(events.some(([event]) => event === 'lease_released_presence_lost'));
});
test('store survives state removal and manager restart; heartbeat renews TTL', async t => {
  const { leases, registry, advance, options, directory } = await setup(t);
  registry.touch(a);
  const lease = await leases.acquire({ task_id: 'a', ttl_seconds: 30 }, a);
  advance(29000); registry.touch(a); advance(2000);
  await fs.writeFile(path.join(directory, 'state.json'), '{}');
  await fs.unlink(path.join(directory, 'state.json'));
  const restored = new CaptureLease({ ...options, registry: undefined });
  assert.equal((await restored.assert(lease.capture_lease_id, a)).lease_id, lease.capture_lease_id);
  assert.equal((await fs.stat(path.join(directory, 'leases.json'))).mode & 0o777, 0o600);
});
test('legacy state migration happens once and retains resources', async t => {
  const { options, directory } = await setup(t);
  const old = { lease_id: 'old', task_id: 'old-task', expires_at: new Date(200000).toISOString(), resources: [{ kind: 'rule', id: 'old-rule', revision: '1' }] };
  const manager = new CaptureLease({ ...options, registry: undefined, read: async () => ({ capture_lease: old }), patch: async () => {} });
  await manager.summary();
  const data = JSON.parse(await fs.readFile(path.join(directory, 'leases.json')));
  assert.equal(Object.values(data.leases)[0].resources[0].id, 'old-rule');
  await manager.release({ capture_lease_id: 'old' });
  const restored = new CaptureLease({ ...options, registry: undefined, read: async () => ({ capture_lease: old }) });
  assert.equal((await restored.summary()).other_lease_count, 0);
});

test('expiry retains orphans, and reacquisition does not reclaim them silently', async t => {
  const { leases, advance } = await setup(t);
  const first = await leases.acquire({ task_id: 'a', ttl_seconds: 30 }, a);
  await leases.trackResource(first.capture_lease_id, { kind: 'rule', id: 'expired', revision: '1' });
  advance(30001);
  await assert.rejects(leases.assert(first.capture_lease_id, a), { code: 'CAPTURE_LEASE_EXPIRED' });
  const next = await leases.acquire({ task_id: 'a' }, a);
  assert.notEqual(next.capture_lease_id, first.capture_lease_id);
  assert.equal(next.lease_status.owned_resource_count, 0);
  assert.equal(next.lease_status.orphaned_resource_count, 1);
});

test('lease tools declare and validate caller-only status and explicit finish task_id', async t => {
  const { MCP_TOOLS, successToolResult } = await import('../src/lib/mcp-contract.mjs');
  const { leases } = await setup(t);
  for (const [name, result] of [
    ['acquire_capture_lease', await leases.acquire({ task_id: 'a' }, a)],
    ['release_capture_lease', await leases.release({ task_id: 'a' }, a)],
  ]) {
    const contract = MCP_TOOLS.find(tool => tool.name === name);
    assert.ok(contract.outputSchema.safeParse(successToolResult(name, {}, result).structuredContent).success);
    const invalid = { ...result, lease_status: { ...result.lease_status, other_lease_count: -1 } };
    assert.equal(contract.outputSchema.safeParse(successToolResult(name, {}, invalid).structuredContent).success, false);
  }
  assert.ok(MCP_TOOLS.find(tool => tool.name === 'finish_capture_task').inputSchema.task_id);
});

test('bounded store rejects overflow without discarding orphan evidence', async t => {
  const { leases, directory } = await setup(t);
  const lease = await leases.acquire({ task_id: 'a' }, a);
  const file = path.join(directory, 'leases.json');
  const data = JSON.parse(await fs.readFile(file));
  const original = Object.values(data.leases)[0];
  for (let n = 1; n < 256; n++) data.leases[JSON.stringify([a.client_id, `task-${n}`])] = { ...original, lease_id: `id-${n}`, task_id: `task-${n}`, resources: [] };
  await fs.writeFile(file, JSON.stringify(data));
  await assert.rejects(leases.acquire({ task_id: 'overflow' }, a), { code: 'TASK_LEASE_LIMIT' });
  data.orphaned_resources = Array.from({ length: 1024 }, (_, n) => ({ kind: 'rule', id: `orphan-${n}`, revision: '1', last_owner_client: b.client_id, last_owner_task: b.task_id, orphaned_at: new Date().toISOString() }));
  await fs.writeFile(file, JSON.stringify(data));
  await assert.rejects(leases.trackResource(lease.capture_lease_id, { kind: 'rule', id: 'overflow', revision: '1' }), { code: 'TASK_RESOURCE_LIMIT' });
  assert.equal((await leases.summary(a)).orphaned_resource_count, 1024);
});
