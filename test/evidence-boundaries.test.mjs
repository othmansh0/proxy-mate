import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const { ProxyEngine } = await import('../src/lib/proxy.mjs');
const { makeTools } = await import('../src/lib/tools.mjs');
const { STATE_DIR } = await import('../src/lib/config.mjs');
const document = { openapi: '3.0.3', paths: {} };
const flowTools = ['get_flow_detail', 'export_flow_curl', 'export_flow_code', 'export_flow_swift', 'repeat_flow', 'edit_and_repeat_flow', 'save_body_to_file', 'query_flow_json', 'inspect_flow_protocol', 'validate_flow_openapi', 'capture_to_mock', 'compare_flows'];
const connectionTools = ['get_websocket_connection', 'export_websocket_transcript', 'plan_websocket_replay', 'transform_websocket_transcript'];
async function fixture(t) {
  const engine = new ProxyEngine({ sessionId: `boundaries-${randomUUID()}` });
  await engine.sessionStore.createSession({ id: engine.sessionId });
  t.after(() => engine.sessionStore.close());
  const flow = { id: 'foreign', owner_client: 'B', attribution: 'claim', request: { method: 'POST', url: 'https://private.invalid/secret', body_inline: '{"secret":"body"}' }, response: { statusCode: 200, body_inline: '{}' } };
  await engine.sessionStore.appendFlow({ sessionId: engine.sessionId, flow });
  engine.flows.set(flow.id, flow); engine.flowOrder.push(flow.id);
  engine.webSocketStore.onRequest({ id: 'foreign', url: 'wss://private.invalid/socket' });
  engine.pluginStore.get = async () => ({ id: 'plugin', stage: 'websocket_offline' });
  return { engine, tools: makeTools({ engine, pacServer: {} }) };
}
for (const name of flowTools) test(`${name} rejects foreign evidence before reading bodies or replaying`, async t => {
  const { tools } = await fixture(t);
  await assert.rejects(tools[name]({ flow_id: 'foreign', left_flow_id: 'foreign', right_flow_id: 'foreign', document }, { client_id: 'A' }), { code: 'FLOW_OUT_OF_SCOPE' });
});
for (const name of connectionTools) test(`${name} rejects foreign connections`, async t => {
  const { tools } = await fixture(t);
  await assert.rejects(tools[name]({ connection_id: 'foreign', plugin_id: 'plugin' }, { client_id: 'A' }), { code: 'CONNECTION_OUT_OF_SCOPE' });
});
test('flow exports retain explicit all and legacy access', async t => {
  const { tools } = await fixture(t);
  assert.match((await tools.export_flow_curl({ flow_id: 'foreign', scope: 'all' }, { client_id: 'A' })).curl, /private.invalid/);
  assert.match((await tools.export_flow_curl({ flow_id: 'foreign' })).curl, /private.invalid/);
});
test('OpenAPI batch filters before applying the limit', async t => {
  const { tools } = await fixture(t);
  const result = await tools.validate_capture_openapi({ document, max_flows: 1 }, { client_id: 'A' });
  assert.equal(result.total, 0);
  assert.equal(result.hidden_count, 1);
});
for (const name of ['import_capture_session', 'import_har']) test(`${name} gates shared replacement and refuses active replacement`, async t => {
  const { engine, tools } = await fixture(t);
  const target = `target-${randomUUID()}`;
  await engine.sessionStore.createSession({ id: target });
  await engine.sessionStore.appendFlow({ sessionId: target, flow: { id: 'keep', owner_client: 'B', attribution: 'claim', request: { url: 'https://private.invalid/' } } });
  const dir = path.join(STATE_DIR, 'exports');
  await fs.mkdir(dir, { recursive: true });
  const source = path.join(dir, `${name}.json`);
  const capture = await engine.sessionStore.exportSession(target);
  await fs.writeFile(source, JSON.stringify(name === 'import_har' ? { log: { entries: [] } } : capture));
  const args = { path: source, replace: true, session_id: target };
  for (const extras of [{}, { confirm_shared: true }, { scope: 'all' }]) {
    await assert.rejects(tools[name]({ ...args, ...extras }, { client_id: 'A' }), e => e.code === 'CONFIRM_SHARED_REQUIRED' && e.details.kept_other_clients_count === 1);
    assert.ok(await engine.sessionStore.getFlow({ sessionId: target, flowId: 'keep' }));
  }
  await tools[name]({ ...args, scope: 'all', confirm_shared: true }, { client_id: 'A' });
  await assert.rejects(tools[name]({ ...args, session_id: engine.sessionId, scope: 'all', confirm_shared: true }, { client_id: 'A' }), { code: 'ACTIVE_SESSION_REPLACE_FORBIDDEN' });
});
test('all evidence contracts accept scope; replacement contracts accept confirmation', async () => {
  const { MCP_TOOLS } = await import('../src/lib/mcp-contract.mjs');
  for (const name of [...flowTools, ...connectionTools, 'import_websocket_transcript', 'validate_capture_openapi', 'import_capture_session', 'import_har']) {
    const def = MCP_TOOLS.find(d => d.name === name);
    assert.equal(def.inputSchema.scope?.safeParse('all').success, true, name);
    if (['import_capture_session', 'import_har'].includes(name)) assert.equal(def.inputSchema.confirm_shared?.safeParse(true).success, true);
  }
});
test('ownership guidance describes resource-scoped task leases', async () => {
  const { searchHelp, SERVER_INSTRUCTIONS } = await import('../src/lib/guidance.mjs');
  const text = searchHelp('ownership', 20).results.find(r => r.id === 'ownership').text;
  for (const value of [text, SERVER_INSTRUCTIONS]) {
    assert.match(value, /resource-scoped/);
    assert.match(value, /[Bb]reakpoint resolution is always allowed/);
    assert.doesNotMatch(value, /cannot change shared controls during the lease/);
  }
});
test('connection scope uses the same normalized ID as transcript lookup', async t => {
  const { tools } = await fixture(t);
  await assert.rejects(tools.plan_websocket_replay({ connection_id: ' foreign ' }, { client_id: 'A' }), { code: 'CONNECTION_OUT_OF_SCOPE' });
});
test('owned and shared WebSocket access and body exports remain available', async t => {
  const { engine, tools } = await fixture(t);
  engine.webSocketStore.connections.get('foreign').owner_client = 'A';
  assert.equal((await tools.get_websocket_connection({ connection_id: 'foreign' }, { client_id: 'A' })).id, 'foreign');
  assert.equal((await tools.get_websocket_connection({ connection_id: 'foreign', scope: 'all' }, { client_id: 'Z' })).id, 'foreign');
  assert.equal((await tools.get_websocket_connection({ connection_id: 'foreign' })).id, 'foreign');
  assert.match(await fs.readFile((await tools.save_body_to_file({ flow_id: 'foreign' }, { client_id: 'B' })).path, 'utf8'), /\{\}/);
});
test('WebSocket transcript imports cannot overwrite a foreign connection by embedded ID', async t => {
  const { tools } = await fixture(t);
  const dir = path.join(STATE_DIR, 'exports');
  await fs.mkdir(dir, { recursive: true });
  const source = path.join(dir, `ws-${randomUUID()}.json`);
  await fs.writeFile(source, JSON.stringify({ format: 'proxyfan.websocket-transcript/v1', connection: { id: 'foreign', messages: [] } }));
  await assert.rejects(tools.import_websocket_transcript({ path: source }, { client_id: 'A' }), { code: 'CONNECTION_OUT_OF_SCOPE' });
});
test('capture replacement checks the embedded active session ID', async t => {
  const { engine, tools } = await fixture(t);
  const dir = path.join(STATE_DIR, 'exports');
  await fs.mkdir(dir, { recursive: true });
  const source = path.join(dir, `active-${randomUUID()}.json`);
  await fs.writeFile(source, JSON.stringify(await engine.sessionStore.exportSession(engine.sessionId)));
  await assert.rejects(tools.import_capture_session({ path: source, replace: true, scope: 'all', confirm_shared: true }), { code: 'ACTIVE_SESSION_REPLACE_FORBIDDEN' });
  assert.ok(await engine.sessionStore.getFlow({ sessionId: engine.sessionId, flowId: 'foreign' }));
});
