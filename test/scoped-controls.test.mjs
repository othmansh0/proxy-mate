import test from 'node:test';
import assert from 'node:assert/strict';
import { BreakpointManager, createMockttpBreakpointCallbacks, createBreakpointScope } from '../src/lib/breakpoints.mjs';
import { makeTools } from '../src/lib/tools.mjs';
import { createRoutingClaimsStore } from '../src/lib/routing-claims.mjs';
import { INTERNAL_CAPTURE_CONTROL } from '../src/lib/capture-lease.mjs';
const owner = { client_id: 'a', task_id: 'task-a' };
const A = 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', B = 'BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB';
test('mine breakpoints isolate devices and skip ambiguous shared hosts without waiting', async () => {
  const claims = [owner, { client_id: 'b', task_id: 'private-task' }].map((o, i) => ({ ...o, domains: ['api.test'], device_udids: [i ? B : A], expires_at: new Date(Date.now()+60000).toISOString() }));
  const scope = createBreakpointScope({ listClaims: async () => claims, isAlive: () => true });
  scope({ owner, hostname: 'api.test' });
  await new Promise(setImmediate);
  const manager = new BreakpointManager();
  const callbacks = createMockttpBreakpointCallbacks(manager, { ruleId: 'scoped', response: false, owner, scope: 'mine', inScope: req => scope({ owner, hostname: 'api.test', device_udid: req.device }) });
  const pending = callbacks.beforeRequest({ url: 'https://api.test/', device: A });
  assert.equal(manager.listPending().length, 1);
  manager.resolve(manager.listPending()[0].id, { action: 'continue' });
  await pending;
  await callbacks.beforeRequest({ url: 'https://api.test/', device: B });
  await callbacks.beforeRequest({ url: 'https://api.test/' });
  assert.equal(manager.getStatus().skipped_out_of_scope, 2);
  assert.equal(manager.getHistory({ outcome: 'skipped_out_of_scope' }).length, 2);
});
test('global controls guard other live claims, force overrides and shutdown bypasses the tool guard', async () => {
  const store = createRoutingClaimsStore();
  await store.upsertClaim({ client_id: 'b', task_id: 'private-task', domains: ['api.test'], durationSeconds: 60 });
  let alive = true, stopped = 0;
  const engine = { recording: true, setRecording(enabled) { this.recording = enabled; return { recording: enabled }; }, stop: async () => { stopped++; }, isRunning: () => true };
  const tools = makeTools({ engine, pacServer: {}, clientRegistry: { isAlive: () => alive } });
  for (const name of ['stop_proxy', 'toggle_recording', 'start_app_capture', 'restart_sim_apps', 'setup_simulator_certificate']) {
    await assert.rejects(tools[name]({}, owner), e => e.code === 'OTHER_CLIENTS_ACTIVE' && e.details.other_clients_active === 1 && !e.message.includes('private-task'));
  }
  await assert.rejects(tools.start_proxy({ auto_setup: true }, owner), { code: 'OTHER_CLIENTS_ACTIVE' });
  await tools.stop_proxy({ force: true }, owner);
  assert.equal(stopped, 1);
  await tools.toggle_recording({ force: true, enabled: false }, owner);
  assert.equal(engine.recording, false);
  await tools[INTERNAL_CAPTURE_CONTROL].stop_proxy({}, { skipRouting: true });
  assert.equal(stopped, 2);
  alive = false;
  await tools.toggle_recording({ enabled: true }, owner);
  assert.equal(engine.recording, true);
  await tools.stop_proxy({}, owner);
  assert.equal(stopped, 3);
  await store.removeAllClaims();
});
test('restarts default to caller devices using an injected Simulator operation', async () => {
  const store = createRoutingClaimsStore();
  await store.upsertClaim({ ...owner, domains: ['api.test'], device_udids: [A], durationSeconds: 60 });
  const calls = [];
  const tools = makeTools({ engine: {}, pacServer: {}, restartApps: async args => { calls.push(args); return { restarted: [{ udid: args.udid }], failed: [] }; } });
  await tools.restart_sim_apps({}, owner);
  assert.deepEqual(calls.map(c => c.udid), [A]);
  await store.removeAllClaims();
});

test('breakpoint scope supports cold snapshots, unique claims, dead peers, and legacy all', async () => {
  const claims = [{ ...owner, domains: ['*.test'], expires_at: new Date(Date.now()+60000).toISOString() }];
  let alive = true;
  const scope = createBreakpointScope({ listClaims: async () => claims, isAlive: () => alive });
  assert.equal(scope({ owner, hostname: 'api.test' }), false);
  await new Promise(setImmediate);
  assert.equal(scope({ owner, hostname: 'api.test' }), true);
  claims.push({ client_id: 'b', domains: ['*.test'], expires_at: claims[0].expires_at });
  // Snapshot is immutable until the next refresh.
  const shared = createBreakpointScope({ listClaims: async () => claims, isAlive: () => alive });
  shared({ owner }); await new Promise(setImmediate);
  assert.equal(shared({ owner, hostname: 'api.test' }), false);
  alive = false;
  assert.equal(shared({ owner, hostname: 'api.test' }), true);
  const manager = new BreakpointManager();
  const cb = createMockttpBreakpointCallbacks(manager, { ruleId: 'legacy', response: false });
  const pending = cb.beforeRequest({ url: 'https://foreign.test/' });
  assert.equal(manager.listPending().length, 1);
  manager.close(); await pending;
});

test('contract declares scope, force, owner and skip counts', async () => {
  const { MCP_TOOLS, successToolResult } = await import('../src/lib/mcp-contract.mjs');
  for (const name of ['stop_proxy', 'toggle_recording', 'start_app_capture', 'restart_sim_apps', 'setup_simulator_certificate', 'start_proxy']) {
    assert.ok(MCP_TOOLS.find(t => t.name === name).inputSchema.force, name);
  }
  assert.ok(MCP_TOOLS.find(t => t.name === 'create_breakpoint').inputSchema.scope);
  const tool = MCP_TOOLS.find(t => t.name === 'create_breakpoint');
  const payload = rule => successToolResult(tool.name, {}, { status: 'registered', rule }).structuredContent;
  assert.equal(tool.outputSchema.safeParse(payload({ owner, scope: 'mine' })).success, true);
  assert.equal(tool.outputSchema.safeParse(payload({ owner: { client_id: 7 }, scope: 'mine' })).success, false);
});
