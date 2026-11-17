import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rule-ownership-'));
process.env.PROXY_MATE_HOME = root;
const { ProxyEngine } = await import('../src/lib/proxy.mjs');
const { makeTools } = await import('../src/lib/tools.mjs');
const { PacServer } = await import('../src/lib/pac.mjs');
const { saveRules, loadRules } = await import('../src/lib/rules.mjs');
const a = { client_id: 'a', task_id: 'task-a' }, b = { client_id: 'b', task_id: 'secret-task-b' };
test.after(() => fs.rm(root, { recursive: true, force: true }));
async function setup(t) {
  const engine = new ProxyEngine();
  const tools = makeTools({ engine, pacServer: new PacServer(), clientRegistry: { isAlive: () => true, list: () => [] } });
  await engine.start({ port: 0 });
  t.after(() => engine.stop());
  return { engine, tools };
}
const mock = { url: 'http://api.test/value', json: { ok: true } };
test('default ids isolate callers; public lists and exports hide foreign task ownership', async t => {
  const { tools, engine } = await setup(t);
  const first = await tools.mock_json_response(mock, a);
  const second = await tools.mock_json_response(mock, b);
  assert.notEqual(first.rule_id, second.rule_id);
  assert.deepEqual(engine.listRuleConfigs()[0].owner, a);
  const rules = (await tools.list_rules({}, a)).rules;
  assert.equal(rules[0].mine, true);
  assert.deepEqual(rules[1].owner, { mine: false });
  const out = await tools.export_rules({ path: path.join(root, 'export.json') }, a);
  const exported = JSON.parse(await fs.readFile(out.path));
  assert.deepEqual(exported.rules[1].owner, { mine: false });
});
test('live explicit collisions and mutations conflict; force overrides mutations', async t => {
  const { tools } = await setup(t);
  await tools.mock_json_response({ ...mock, rule_id: 'shared' }, a);
  for (const [name, args] of [ ['mock_json_response', { ...mock, rule_id: 'shared' }], ['update_rule', { rule_id: 'shared', patch: { status: 201 } }], ['remove_rule', { rule_id: 'shared' }], ['set_rule_enabled', { rule_id: 'shared', enabled: false }], ['set_rule_priority', { rule_id: 'shared', priority: 9 }], ['reorder_rules', { rule_ids: ['shared'] }] ]) {
    await assert.rejects(tools[name](args, b), e => e.code === 'RULE_CONFLICT' && e.recovery.length > 0);
    if (name !== 'mock_json_response' && name !== 'remove_rule') await tools[name]({ ...args, force: true }, b);
  }
  await tools.remove_rule({ rule_id: 'shared', force: true }, b);
});
test('clear defaults to mine; all requires confirmation; legacy rules remain mutable', async t => {
  const { tools, engine } = await setup(t);
  await tools.mock_json_response({ ...mock, rule_id: 'a' }, a);
  await tools.mock_json_response({ ...mock, rule_id: 'b' }, b);
  await engine.registerRule({ rule_id: 'legacy', url_pattern: '.*', body: 'legacy' });
  await tools.update_rule({ rule_id: 'legacy', patch: { status: 202 } }, a);
  await tools.clear_rules({}, a);
  assert.deepEqual(engine.listRuleConfigs().map(r => r.rule_id), ['b']);
  await assert.rejects(tools.clear_rules({ scope: 'all' }, a), { code: 'CONFIRM_SHARED_REQUIRED' });
  await tools.clear_rules({ scope: 'all', confirm_shared: true }, a);
  assert.equal(engine.listRuleConfigs().length, 0);
});
test('JSON mock preserves and validates match headers; owners round trip and old files replay', async t => {
  const { tools, engine } = await setup(t);
  await tools.mock_json_response({ ...mock, match_headers: { 'x-test': 'yes' } }, a);
  assert.deepEqual(engine.listRuleConfigs()[0].match_headers, { 'x-test': 'yes' });
  await assert.rejects(tools.mock_json_response({ ...mock, match_headers: { 'bad\nname': 'yes' } }, a));
  await saveRules(engine.listRuleConfigs());
  assert.deepEqual((await loadRules())[0].owner, a);
  await fs.writeFile(path.join(root, 'rules.json'), JSON.stringify([{ rule_id: 'old', url_pattern: '.*', body_inline: 'old' }]));
  await engine.registerRule((await loadRules())[0]);
  assert.equal(engine.listRuleConfigs().find(r => r.rule_id === 'old').owner, null);
});

test('mine matching uses owner device and unique host at request time', async t => {
  const { createBreakpointScope } = await import('../src/lib/breakpoints.mjs');
  const { request } = await import('node:http');
  const { engine, tools } = await setup(t);
  let device = 'A';
  engine.deviceResolver = () => device;
  const claims = [ { ...a, domains: ['api.test', 'unique.test'], device_udids: ['A'] },
    { ...b, domains: ['api.test'], device_udids: ['B'] } ].map(c => ({ ...c, expires_at: new Date(Date.now() + 60000).toISOString() }));
  engine.breakpointScope = createBreakpointScope({ listClaims: async () => claims });
  engine.breakpointScope({}); await new Promise(setImmediate);
  await tools.mock_json_response({ ...mock, match_scope: 'mine', priority: 10 }, a);
  await tools.mock_json_response({ ...mock, url: 'http://unique.test/value', match_scope: 'mine', priority: 10 }, a);
  await engine.registerRule({ rule_id: 'fallback', url_pattern: '.*', status: 209, body: 'fallback' });
  const get = url => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: engine.port, path: url }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  assert.equal(await get(mock.url), 200);
  device = 'B'; assert.equal(await get(mock.url), 209);
  device = null; assert.equal(await get(mock.url), 209);
  assert.equal(await get('http://unique.test/value'), 200);
});
test('lease tracking still cleans unchanged mocks and forced mutation bypasses generic lease conflicts', async t => {
  const { tools, engine } = await setup(t);
  const lease = await tools.acquire_capture_lease({ task_id: a.task_id }, a);
  const rule = await tools.mock_json_response({ ...mock, capture_lease_id: lease.capture_lease_id }, a);
  await assert.rejects(tools.remove_rule({ rule_id: rule.rule_id }, b), { code: 'RULE_CONFLICT' });
  await tools.set_rule_priority({ rule_id: rule.rule_id, priority: 8, force: true }, b);
  const second = await tools.mock_json_response({ ...mock, rule_id: 'cleanup', capture_lease_id: lease.capture_lease_id }, a);
  await tools.finish_capture_task({ capture_lease_id: lease.capture_lease_id }, a);
  assert.equal(engine.listRuleConfigs().some(r => r.rule_id === second.rule_id), false);
  assert.equal(engine.listRuleConfigs().some(r => r.rule_id === rule.rule_id), true);
});
test('rule contracts declare ownership, matching, force and shared confirmation', async () => {
  const { MCP_TOOLS, successToolResult } = await import('../src/lib/mcp-contract.mjs');
  const tool = name => MCP_TOOLS.find(t => t.name === name);
  for (const name of ['create_map_local', 'mock_json_response', 'create_map_remote', 'create_blacklist', 'create_network_condition', 'create_no_cache_rule', 'capture_to_mock', 'create_transform_plugin_rule', 'import_rules']) assert.ok(tool(name).inputSchema.match_scope, name);
  for (const name of ['update_rule', 'remove_rule', 'set_rule_enabled', 'set_rule_priority', 'reorder_rules', 'patch_mock_json']) assert.ok(tool(name).inputSchema.force, name);
  assert.ok(tool('mock_json_response').inputSchema.match_headers);
  assert.ok(tool('clear_rules').inputSchema.confirm_shared);
  const result = owner => successToolResult('list_rules', {}, { rules: [{ owner, mine: false }] }).structuredContent;
  assert.equal(tool('list_rules').outputSchema.safeParse(result({ mine: false })).success, true);
  assert.equal(tool('list_rules').outputSchema.safeParse(result({ client_id: 7 })).success, false);
});
test('reordering also protects foreign rules whose order would change', async t => {
  const { tools } = await setup(t);
  await tools.mock_json_response({ ...mock, rule_id: 'a-first' }, a);
  await tools.mock_json_response({ ...mock, rule_id: 'b-second' }, b);
  await tools.mock_json_response({ ...mock, rule_id: 'a-last' }, a);
  await assert.rejects(tools.reorder_rules({ rule_ids: ['a-last'] }, a), { code: 'RULE_CONFLICT' });
});
test('imported rules become caller owned and are tracked by the task lease', async t => {
  const { tools, engine } = await setup(t);
  const input = path.join(root, 'import.json');
  await fs.writeFile(input, JSON.stringify({ rules: [{ rule_id: 'imported', url_pattern: '.*', body_inline: 'ok', owner: b }] }));
  const lease = await tools.acquire_capture_lease({ task_id: a.task_id }, a);
  await tools.import_rules({ path: input, capture_lease_id: lease.capture_lease_id }, a);
  assert.deepEqual(engine.listRuleConfigs()[0].owner, a);
  await tools.finish_capture_task({ capture_lease_id: lease.capture_lease_id }, a);
  assert.equal(engine.listRuleConfigs().length, 0);
});
test('dry-run scope agrees with live matching and foreign mutation output hides task ids', async t => {
  const { tools, engine } = await setup(t);
  engine.breakpointScope = ({ device_udid }) => device_udid === 'A';
  const rule = await tools.mock_json_response({ ...mock, match_scope: 'mine' }, a);
  assert.equal((await tools.test_rule({ rule_id: rule.rule_id, request: { url: mock.url, device_udid: 'B' } }, a)).matched, false);
  assert.equal((await tools.test_rule({ rule_id: rule.rule_id, request: { url: mock.url, device_udid: 'A' } }, a)).matched, true);
  const result = await tools.update_rule({ rule_id: rule.rule_id, patch: { status: 201 }, force: true }, b);
  assert.deepEqual(result.rule.owner, { mine: false });
});
