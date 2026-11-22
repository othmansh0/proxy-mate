import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-task-cleanup-'));
process.env.PROXYFAN_HOME = root;
const { ProxyEngine } = await import('../src/lib/proxy.mjs');
const { makeTools } = await import('../src/lib/tools.mjs');
const { PacServer } = await import('../src/lib/pac.mjs');
const { INTERNAL_CAPTURE_CONTROL } = await import('../src/lib/capture-lease.mjs');
const { saveRules, loadRules } = await import('../src/lib/rules.mjs');
const { patchState } = await import('../src/lib/state.mjs');
test.after(() => fs.rm(root, { recursive: true, force: true }));

async function setup(t, mode = 'in-process') {
  await patchState({ capture_lease: null });
  await saveRules([]);
  const engine = new ProxyEngine();
  const tools = makeTools({ engine, pacServer: new PacServer(), mode });
  await tools.start_proxy({ port: 0, auto_setup: false });
  t.after(async () => { if (engine.isRunning()) await engine.clearRules(); await tools[INTERNAL_CAPTURE_CONTROL].stop_proxy(); });
  return { engine, tools };
}

test('task finish preserves preexisting rules and their shared mock body files', async (t) => {
  const { tools } = await setup(t);
  const foreign = await tools.mock_json_response({ rule_id: 'existing', url: 'http://example.test/existing', json: { keep: true } });
  const lease = await tools.acquire_capture_lease({ task_id: 'one' });
  await tools.create_map_local({ capture_lease_id: lease.capture_lease_id, rule_id: 'task-one', url_pattern: '^http://example.test/task$',
    body_file: foreign.body_file, content_type: 'application/json' });
  const finished = await tools.finish_capture_task({ capture_lease_id: lease.capture_lease_id });
  assert.deepEqual(finished.removed.map((item) => item.id), ['task-one']);
  assert.deepEqual((await tools.list_rules()).rules.map((rule) => rule.rule_id), ['existing']);
  assert.equal(JSON.parse(await fs.readFile(foreign.body_file, 'utf8')).keep, true);
});

test('task finish also removes its persistent fixtures after capture was deliberately stopped', async (t) => {
  const { tools } = await setup(t);
  const foreign = await tools.mock_json_response({ rule_id: 'existing', url: 'http://example.test/existing', json: { keep: true } });
  const lease = await tools.acquire_capture_lease({ task_id: 'two' });
  const owned = await tools.mock_json_response({ capture_lease_id: lease.capture_lease_id, rule_id: 'task-two', url: 'http://example.test/task', json: { remove: true } });
  await tools.stop_proxy({ capture_lease_id: lease.capture_lease_id });
  const finished = await tools.finish_capture_task({ capture_lease_id: lease.capture_lease_id });
  assert.equal(finished.capture_continues, false);
  assert.equal(finished.stored_rules_updated, true);
  assert.deepEqual((await loadRules()).map((rule) => rule.rule_id), ['existing']);
  await assert.rejects(fs.access(owned.body_file), { code: 'ENOENT' });
  await fs.access(foreign.body_file);
});

test('changed resources and explicitly retained QA fixtures survive task finish', async (t) => {
  const { engine, tools } = await setup(t);
  const lease = await tools.acquire_capture_lease({ task_id: 'three' });
  await tools.mock_json_response({ capture_lease_id: lease.capture_lease_id, rule_id: 'changed', url: 'http://example.test/task', json: { initial: true } });
  await engine.updateRule('changed', { body: '{"changedElsewhere":true}' });
  const finished = await tools.finish_capture_task({ capture_lease_id: lease.capture_lease_id });
  assert.deepEqual(finished.retained.map((item) => item.id), ['changed']);
  assert.equal(finished.removed.length, 0);
  const next = await tools.acquire_capture_lease({ task_id: 'four' });
  await tools.mock_json_response({ capture_lease_id: next.capture_lease_id, rule_id: 'keep-for-qa', url: 'http://example.test/qa', json: { keep: true } });
  assert.equal((await tools.finish_capture_task({ capture_lease_id: next.capture_lease_id, keep_resources: true })).retained.length, 1);
  assert.equal((await tools.list_rules()).rules.length, 2);
});


test('old bridges receive reconnect guidance without a capture restart', async (t) => {
  const { tools } = await setup(t, 'daemon');
  const { SERVER_VERSION } = await import('../src/lib/config.mjs');
  const older = await tools.get_proxy_status();
  assert.equal(older.client_compatibility.action, 'reconnect_mcp_client');
  assert.equal(older.client_compatibility.capture_restart_required, false);
  assert.equal(older.running, true);
  assert.equal((await tools.get_proxy_status({}, { bridge_version: SERVER_VERSION })).client_compatibility, undefined);
});

test('explicit task_id finishes only the selected task for the caller', async t => {
  const { tools } = await setup(t);
  const client = { client_id: 'client-cleanup', task_id: 'second' };
  const first = await tools.acquire_capture_lease({ task_id: 'first' }, client);
  await tools.mock_json_response({ capture_lease_id: first.capture_lease_id, rule_id: 'first-only', url: 'http://example.test/first', json: {} }, { ...client, task_id: 'first' });
  const second = await tools.acquire_capture_lease({ task_id: 'second' }, client);
  await tools.mock_json_response({ capture_lease_id: second.capture_lease_id, rule_id: 'second-only', url: 'http://example.test/second', json: {} }, client);
  const result = await tools.finish_capture_task({ task_id: 'first', capture_lease_id: second.capture_lease_id }, client);
  assert.deepEqual(result.removed.map(r => r.id), ['first-only']);
  assert.deepEqual((await tools.list_rules()).rules.map(r => r.rule_id), ['second-only']);
  await assert.rejects(tools.remove_rule({ rule_id: 'second-only' }, { client_id: 'client-other' }), { code: 'RULE_CONFLICT' });
  await tools.finish_capture_task({ task_id: 'second' }, client);
});

test('implicit rule IDs isolate owners and reverse listeners enforce resource ownership', async t => {
  const { tools } = await setup(t);
  const a = { client_id: 'client-rule-a', task_id: 'a' }, b = { client_id: 'client-rule-b', task_id: 'b' };
  await tools.acquire_capture_lease({ task_id: 'a' }, a);
  await tools.acquire_capture_lease({ task_id: 'b' }, b);
  const args = { url: 'http://example.test/shared-default', json: {} };
  const results = await Promise.allSettled([tools.mock_json_response(args, a), tools.mock_json_response(args, b)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
  assert.notEqual(results[0].value.rule_id, results[1].value.rule_id);
  await tools.create_reverse_proxy({ id: 'owned-listener', target_url: 'http://127.0.0.1:9' }, a);
  await assert.rejects(tools.remove_reverse_proxy({ id: 'owned-listener' }, b), { code: 'CAPTURE_OWNED' });
  await tools.finish_capture_task({}, a);
  await tools.finish_capture_task({}, b);
});
