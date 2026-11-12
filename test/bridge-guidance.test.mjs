import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { registerMcpTools } from '../src/lib/mcp-contract.mjs';
import { gettingStarted, searchHelp, SERVER_INSTRUCTIONS } from '../src/lib/guidance.mjs';

test('thin bridge initializes and explains recovery offline without taking capture ownership', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-thin-bridge-'));
  const client = new Client({ name: 'offline-agent', version: '1' });
  t.after(async () => { await client.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['src/client.mjs'],
    cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, PROXY_MCP_HOME: directory }, stderr: 'pipe' }));
  assert.match(client.getInstructions(), /get_started/);
  const start = Date.now();
  const help = await client.callTool({ name: 'get_started', arguments: {} });
  assert.equal(help.isError, undefined); assert.equal(help.structuredContent.data.stage, 'daemon_unavailable');
  assert.ok(Date.now() - start < 2000);
  const docs = await client.callTool({ name: 'search_docs', arguments: { query: 'localhost' } });
  assert.equal(docs.structuredContent.data.results[0].id, 'localhost');
  assert.deepEqual(await fs.readdir(directory), []);
  assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'mock_json_response'));
});

test('onboarding gives scoped localhost arguments and does not claim app traffic is verified', () => {
  const result = gettingStarted({ url: 'http://127.0.0.1:8018', task_id: 'test-import' }, { running: true, recording: true, flows_count: 0 });
  assert.equal(result.app_traffic_verified, false); assert.equal(result.service_ready, true);
  assert.deepEqual(result.next_calls[0], { tool: 'acquire_capture_lease', arguments: { task_id: 'test-import' } });
  assert.deepEqual(result.next_calls[1], { tool: 'create_reverse_proxy', arguments: { id: 'test-import-local', target_url: 'http://127.0.0.1:8018/' } });
  assert.equal(result.network_settings_changed, false);
  assert.match(searchHelp('android').results[0].text, /not implemented/);
  assert.ok(SERVER_INSTRUCTIONS.length < 2048);
});

test('long tools emit monotonic heartbeats and stop them after completion', async () => {
  const callbacks = new Map(), notifications = [];
  registerMcpTools({ registerTool: (name, _options, callback) => callbacks.set(name, callback), sendLoggingMessage: async () => {} },
    async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return { status: 'done' }; }, { heartbeatMs: 5 });
  await callbacks.get('setup_simulator_certificate')({}, { _meta: { progressToken: 'test' }, sendNotification: async (item) => notifications.push(item) });
  assert.ok(notifications.length > 2);
  assert.deepEqual(notifications.map((item) => item.params.progress), notifications.map((_, index) => index));
  const count = notifications.length; await new Promise((resolve) => setTimeout(resolve, 20)); assert.equal(notifications.length, count);
});

test('onboarding reuses active capture, exposes degraded coverage and respects another task lease', () => {
  const state = { running: true, recording: true, app_gateway: { coverage_degraded: true },
    capture_lease: { active: true, task_id: 'other', expires_at: '2099-01-01T00:00:00Z' } };
  const help = gettingStarted({ url: 'https://api.example.test', udid: 'sim', bundle_id: 'com.example.demo', task_id: 'mine' }, state);
  assert.equal(help.stage, 'capture_coverage_degraded');
  assert.deepEqual(help.next_calls.map((next) => next.tool), ['get_flows']);
  assert.equal(gettingStarted({}, null, { daemonReachable: true }).stage, 'daemon_status_unavailable');
});
