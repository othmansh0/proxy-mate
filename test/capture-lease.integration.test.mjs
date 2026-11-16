import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-lease-integration-'));
process.env.PROXY_MATE_HOME = directory;
const { ProxyEngine } = await import('../src/lib/proxy.mjs');
const { makeTools } = await import('../src/lib/tools.mjs');
const { ControlServer } = await import('../src/lib/control.mjs');
const { PacServer } = await import('../src/lib/pac.mjs');
const { INTERNAL_CAPTURE_CONTROL } = await import('../src/lib/capture-lease.mjs');

test('two real MCP bridges coordinate shared mutations while reads, exports and breakpoint resolution keep working', { timeout: 20_000 }, async (t) => {
  const engine = new ProxyEngine();
  await engine.start({ port: 0 });
  const tools = makeTools({ engine, pacServer: new PacServer(), mode: 'test' });
  await tools.mock_json_response({ rule_id: 'existing-qa-fixture', url: 'http://fixture.invalid/keep', json: { keep: true } });
  const control = new ControlServer({ port: 0, tools });
  await control.start();
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await control.stop();
    await tools[INTERNAL_CAPTURE_CONTROL].stop_proxy();
    await fs.rm(directory, { recursive: true, force: true });
  });
  for (let index = 0; index < 2; index++) {
    const client = new Client({ name: `lease-client-${index}`, version: '1' });
    clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['src/client.mjs'],
      cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, PROXY_MATE_HOME: directory }, stderr: 'pipe' }));
  }
  const call = async (index, name, args = {}) => {
    const result = await clients[index].callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result.structuredContent?.error));
    return result.structuredContent.data;
  };
  const lease = await call(0, 'acquire_capture_lease', { task_id: 'qa-a' });
  assert.equal((await call(1, 'get_proxy_status')).capture_lease.task_id, 'qa-a');
  for (const name of ['stop_proxy', 'clear_rules', 'toggle_recording']) {
    const rejected = await clients[1].callTool({ name, arguments: {} });
    assert.equal(rejected.structuredContent.error.code, 'CAPTURE_OWNED');
  }
  const sessionsBefore = (await call(0, 'list_capture_sessions')).sessions.length;
  const failedSwitch = await clients[0].callTool({ name: 'create_capture_session', arguments: { name: 'must-not-be-created', activate: true } });
  assert.equal(failedSwitch.structuredContent.error.code, 'SESSION_SWITCH_REQUIRES_STOPPED_PROXY');
  assert.equal((await call(0, 'list_capture_sessions')).sessions.length, sessionsBefore);
  await call(0, 'update_capture_session', { name: 'QA capture, still running' });
  assert.equal((await call(1, 'get_proxy_status')).running, true);
  const url = 'http://fixture.invalid/leased-breakpoint';
  await call(0, 'create_breakpoint', { rule_id: 'qa-a-pause', url, direction: 'request', timeout_ms: 5000 });
  const request = new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: engine.port, path: url }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
  });
  let pending;
  for (let index = 0; index < 100 && !pending; index++) {
    pending = (await call(0, 'list_pending_breakpoints')).breakpoints[0];
    if (!pending) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(pending);
  const denied = await clients[1].callTool({ name: 'resolve_breakpoint', arguments: { breakpoint_id: pending.id, action: 'continue' } });
  assert.equal(denied.structuredContent.error.code, 'CAPTURE_OWNED');
  await call(0, 'resolve_breakpoint', { breakpoint_id: pending.id, action: 'respond', response: { statusCode: 202, json: { edited: true } } });
  const received = await request;
  assert.equal(received.status, 202);
  assert.deepEqual(JSON.parse(received.text), { edited: true });
  const observed = await call(1, 'wait_for_flow', { url_contains: 'leased-breakpoint', include_existing: true, timeout_ms: 1000 });
  const exported = await call(1, 'save_body_to_file', { flow_id: observed.flow.id });
  assert.equal(exported.redacted, true);
  await call(0, 'remove_rule', { rule_id: 'qa-a-pause' });
  await call(0, 'mock_json_response', { rule_id: 'qa-a-cleanup', url: 'http://fixture.invalid/cleanup', json: { cleanup: true } });
  await call(0, 'patch_mock_json', { rule_id: 'qa-a-cleanup', patch: { updated: true } });
  const reverse = await call(0, 'create_reverse_proxy', { id: 'qa-a-local', target_url: 'http://127.0.0.1:9' });
  assert.ok(reverse.local_url);
  const finished = await call(0, 'finish_capture_task');
  assert.equal(finished.capture_continues, true);
  assert.ok(finished.removed.some((item) => item.id === 'qa-a-cleanup'));
  assert.ok(finished.removed.some((item) => item.id === 'qa-a-local'));
  assert.equal((await call(1, 'list_reverse_proxies')).reverse_proxies.length, 0);
  assert.deepEqual((await call(1, 'list_rules')).rules.map((rule) => rule.rule_id), ['existing-qa-fixture']);
  assert.equal((await call(1, 'get_proxy_status')).running, true);
  await call(1, 'acquire_capture_lease', { task_id: 'qa-b' });
  const renewed = await call(1, 'acquire_capture_lease', { task_id: 'qa-b', ttl_seconds: 1800 });
  assert.equal(renewed.status, 'renewed');
  assert.notEqual(renewed.capture_lease_id, lease.capture_lease_id);
  await call(1, 'release_capture_lease');
});
