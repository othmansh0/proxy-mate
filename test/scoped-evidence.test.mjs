import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.PROXY_MATE_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'wp20-'));
const { ProxyEngine } = await import('../src/lib/proxy.mjs');
const { makeTools } = await import('../src/lib/tools.mjs');
const { PacServer } = await import('../src/lib/pac.mjs');
test('scoped evidence hides other owners before paging and protects clears', async t => {
  const engine = new ProxyEngine();
  await engine.sessionStore.createSession({ id: engine.sessionId });
  t.after(() => engine.sessionStore.close());
  for (const [id, owner_client] of [['a1', 'A'], ['b1', 'B'], ['a2', 'A']]) {
    const { flow } = await engine.sessionStore.appendFlow({ sessionId: engine.sessionId, flow: { id, owner_client, attribution: 'claim', request: { method: 'GET', url: 'https://api.example/x', hostname: 'api.example' } } });
    engine.flows.set(id, flow); engine.flowOrder.push(id);
  }
  const tools = makeTools({ engine, pacServer: new PacServer() });
  const mine = await tools.get_flows({}, { client_id: 'A' });
  assert.deepEqual(mine.flows.map(f => f.id), ['a2', 'a1']);
  assert.equal(mine.hidden_count, 1); assert.equal(mine.scope_applied, 'mine');
  assert.equal((await tools.get_flows({ scope: 'all' }, { client_id: 'A' })).flows.length, 3);
  assert.equal((await tools.get_flows({})).flows.length, 3);
  const page = await tools.get_flows({ session_id: engine.sessionId, limit: 1 }, { client_id: 'A' });
  assert.equal(page.flows[0].id, 'a1');
  const next = await tools.get_flows({ session_id: engine.sessionId, limit: 1, cursor: page.next_cursor }, { client_id: 'A' });
  assert.equal(next.flows[0].id, 'a2'); assert.equal(next.hidden_count, 1);
  await assert.rejects(tools.get_flow_detail({ flow_id: 'b1' }, { client_id: 'A' }), { code: 'FLOW_OUT_OF_SCOPE' });
  const waited = await tools.wait_for_flow({ include_existing: true, timeout_ms: 0 }, { client_id: 'Z' });
  assert.equal(waited.matched, false);
  await assert.rejects(tools.clear_session({ scope: 'all' }, { client_id: 'A' }), { code: 'CONFIRM_SHARED_REQUIRED' });
  const cleared = await tools.clear_session({}, { client_id: 'A' });
  assert.equal(cleared.removed_count, 2); assert.equal(cleared.kept_other_clients_count, 1);
  assert.deepEqual((await tools.get_flows({})).flows.map(f => f.id), ['b1']);
  assert.equal((await tools.clear_session({ scope: 'all', confirm_shared: true }, { client_id: 'A' })).removed_count, 1);
});

test('claims expose devices and shared ambiguous hosts but exclude expired claims', async t => {
  const { createRoutingClaimsStore } = await import('../src/lib/routing-claims.mjs');
  const store = createRoutingClaimsStore();
  const device = 'AAAAAAAA-1111-2222-3333-444444444444';
  for (const client_id of ['A', 'B']) await store.upsertClaim({ client_id, domains: ['*.shared.example'], device_udids: client_id === 'A' ? [device] : [], durationSeconds: 60 });
  const engine = new ProxyEngine({ sessionId: "claims" });
  await engine.sessionStore.createSession({ id: engine.sessionId });
  t.after(() => engine.sessionStore.close());
  for (const flow of [
    { id: 'amb', attribution: 'ambiguous', request: { hostname: 'api.shared.example', url: 'https://api.shared.example/x', method: 'GET' } },
    { id: 'dev', attribution: 'unknown', device_udid: device, request: { hostname: 'private.example', url: 'https://private.example/x', method: 'GET' } },
    { id: 'other', owner_client: 'C', attribution: 'claim', request: { hostname: 'api.shared.example', url: 'https://api.shared.example/x', method: 'GET' } },
  ]) {
    const result = await engine.sessionStore.appendFlow({ sessionId: engine.sessionId, flow });
    engine.flows.set(flow.id, result.flow); engine.flowOrder.push(flow.id);
  }
  const tools = makeTools({ engine, pacServer: new PacServer() });
  assert.deepEqual((await tools.get_flows({}, { client_id: 'A' })).flows.map(f => f.id), ['dev', 'amb']);
  assert.deepEqual((await tools.get_flows({}, { client_id: 'B' })).flows.map(f => f.id), ['amb']);
  const durable = await tools.get_flows({ session_id: engine.sessionId }, { client_id: 'A' });
  assert.deepEqual(durable.flows.map(f => f.id), ['amb', 'dev']); assert.equal(durable.hidden_count, 1);
  assert.equal((await tools.analyze_capture({}, { client_id: 'B' })).hidden_count, 2);
  await assert.rejects(tools.update_capture_session({ retention: { max_flows: 1 } }, { client_id: 'A' }), { code: 'CONFIRM_SHARED_REQUIRED' });
  const expired = makeTools({ engine, pacServer: new PacServer(), now: () => Date.now() + 120000 });
  assert.equal((await expired.get_flows({}, { client_id: 'A' })).flows.length, 0);
  const result = await tools.purge_capture_session({ older_than_ms: 0 }, { client_id: 'B' });
  assert.equal(result.removed_count, 1); assert.equal(result.kept_other_clients_count, 2);
});

test('WebSocket scope filters before limits and preserves other hosts on clear', async t => {
  const { createRoutingClaimsStore } = await import('../src/lib/routing-claims.mjs');
  await createRoutingClaimsStore().upsertClaim({ client_id: 'ws-A', domains: ['a.ws.test'], durationSeconds: 60 });
  const engine = new ProxyEngine({ sessionId: 'ws' });
  await engine.sessionStore.createSession({ id: engine.sessionId });
  t.after(() => engine.sessionStore.close());
  for (const [id, host] of [['wa', 'a.ws.test'], ['wb', 'b.ws.test']]) {
    engine.webSocketStore.onRequest({ id, url: `wss://${host}/socket` });
    engine.webSocketStore.onMessageReceived({ id, data: 'hello' });
  }
  const tools = makeTools({ engine, pacServer: new PacServer() });
  const page = await tools.list_websocket_connections({ limit: 1 }, { client_id: 'ws-A' });
  assert.deepEqual(page.connections.map(c => c.id), ['wa']); assert.equal(page.hidden_count, 1);
  const hidden = await tools.get_websocket_messages({ connection_id: 'wb' }, { client_id: 'ws-A' });
  assert.deepEqual(hidden.messages, []); assert.equal(hidden.hidden_count, 1); assert.equal(hidden.connection, undefined);
  assert.equal((await tools.get_websocket_messages({ connection_id: 'wb', scope: 'all' }, { client_id: 'ws-A' })).messages.length, 1);
  await tools.clear_session({}, { client_id: 'ws-A' });
  assert.deepEqual((await tools.list_websocket_connections()).connections.map(c => c.id), ['wb']);
});

test('scoped tool contracts declare inputs, metadata and destructive counts', async () => {
  const { MCP_TOOLS, successToolResult } = await import('../src/lib/mcp-contract.mjs');
  for (const name of ['get_flows', 'filter_flows', 'get_flow_detail', 'wait_for_flow', 'export_har', 'export_capture_session', 'analyze_capture', 'assert_capture', 'compare_flows', 'list_websocket_connections', 'get_websocket_messages']) {
    const def = MCP_TOOLS.find(t => t.name === name);
    assert.equal(def.inputSchema.scope.safeParse('all').success, true);
    assert.equal(def.inputSchema.scope.safeParse('invalid').success, false);
    const sample = { scope_applied: 'mine', hidden_count: 2, flows: [], id: 'one', matched: false, left_flow_id: 'one', right_flow_id: 'two' };
    assert.equal(def.outputSchema.safeParse(successToolResult(name, {}, sample).structuredContent).success, true, name);
  }
  for (const name of ['clear_session', 'purge_capture_session', 'update_capture_session']) {
    const def = MCP_TOOLS.find(t => t.name === name);
    assert.equal(def.inputSchema.confirm_shared.safeParse(true).success, true);
    assert.equal(def.outputSchema.safeParse(successToolResult(name, {}, { removed_count: 1, kept_other_clients_count: 2 }).structuredContent).success, true);
  }
});

test('exports, analysis and confirmed retention contain only selected evidence', async t => {
  const engine = new ProxyEngine({ sessionId: 'exports' });
  await engine.sessionStore.createSession({ id: engine.sessionId });
  t.after(() => engine.sessionStore.close());
  for (const owner of ['export-A', 'export-B']) {
    const { flow } = await engine.sessionStore.appendFlow({ sessionId: engine.sessionId, flow: { id: owner, owner_client: owner, attribution: 'claim', timestamp: Date.now(), request: { method: 'GET', hostname: 'export.test', url: `https://export.test/${owner}` }, response: { statusCode: 200 } } });
    engine.flows.set(flow.id, flow); engine.flowOrder.push(flow.id);
  }
  const tools = makeTools({ engine, pacServer: new PacServer() });
  const context = { client_id: 'export-A' };
  for (const name of ['export_har', 'export_capture_session']) {
    const result = await tools[name]({}, context);
    assert.equal(result.hidden_count, 1);
    const text = await fs.readFile(result.path, 'utf8');
    assert.match(text, /export-A/); assert.doesNotMatch(text, /export-B/);
  }
  assert.equal((await tools.assert_capture({}, context)).hidden_count, 1);
  await assert.rejects(tools.compare_flows({ left_flow_id: 'export-A', right_flow_id: 'export-B' }, context), { code: 'FLOW_OUT_OF_SCOPE' });
  const result = await tools.update_capture_session({ retention: { max_flows: 1 }, scope: 'all', confirm_shared: true }, context);
  assert.equal(result.removed_count, 1); assert.equal(result.kept_other_clients_count, 1);
  assert.deepEqual((await tools.get_flows({ scope: 'all' }, context)).flows.map(f => f.id), ['export-B']);
});
