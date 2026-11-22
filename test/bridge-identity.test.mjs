import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

process.env.PROXYFAN_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-bridge-identity-'));
const { ControlServer } = await import('../src/lib/control.mjs');
const { CLIENT_ID_HEADER, normalizeClientId } = await import('../src/lib/client-identity.mjs');

for (const entry of [['src/client.mjs'], ['src/server.mjs', '--require-daemon']]) {
  test(`${entry[0]} forwards stable process and task identity and reuses RPC readiness`, async (t) => {
    const contexts = [], headers = [];
    const tools = Object.fromEntries(['get_started', 'get_proxy_status', 'acquire_capture_lease', 'finish_capture_task'].map((name) =>
      [name, async (_args, context) => {
        contexts.push({ name, client_id: context.client_id, task_id: context.task_id });
        return { status: name === 'finish_capture_task' ? 'finished' : 'acquired', task_id: context.task_id,
          expires_at: '2099-01-01T00:00:00Z', removed: [], retained: [], kept: [], orphaned: [],
          lease_status: { active: false, task_id: null, expires_at: null, owned_resource_count: 0, other_lease_count: 0, orphaned_resource_count: 0, orphaned_resources: [] }, capture_continues: true, evidence_preserved: true,
          running: false, capture_lease_id: '68b5c887-19e6-48fd-856b-7d1da62e6816', lease_released: true };
      }]));
    const control = new ControlServer({ port: 0, tools });
    const client = new Client({ name: 'identity-test', version: '1' });
    await control.start();
    t.after(async () => { await client.close(); await control.stop(); });
    let probes = 0;
    control.server.on('request', (req) => { if (req.url === '/health') probes++; headers.push(req.headers[CLIENT_ID_HEADER]); });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: entry,
      cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env }, stderr: 'pipe' }));
    for (const [name, args] of [['get_started', { task_id: 'onboarding' }], ['get_proxy_status', {}],
      ['acquire_capture_lease', { task_id: 'capture' }], ['finish_capture_task', {}], ['get_proxy_status', {}]]) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, undefined, JSON.stringify({ name, result }));
    }
    assert.deepEqual(contexts.map((item) => item.task_id), ['onboarding', 'onboarding', 'capture', 'capture', 'capture']);
    assert.ok(normalizeClientId(contexts[0].client_id));
    assert.ok(contexts.every((item) => item.client_id === contexts[0].client_id));
    assert.ok(headers.every((id) => id === contexts[0].client_id));
    assert.equal(probes, 1);
  });
}
