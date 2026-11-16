import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-node-api-'));
process.env.PROXY_MATE_HOME = directory;
const { createProxyClient } = await import('../src/index.mjs');
const { ControlServer } = await import('../src/lib/control.mjs');
test.after(() => fs.rm(directory, { recursive: true, force: true }));

test('library import/construction has no state effects and missing/cancelled calls are actionable', async () => {
  assert.deepEqual(await fs.readdir(directory), []);
  const client = createProxyClient({ home: directory, readyTimeoutMs: 0 });
  assert.deepEqual(await fs.readdir(directory), []);
  await assert.rejects(client.callTool('get_proxy_status'), { code: 'DAEMON_UNAVAILABLE' });
  const aborted = AbortSignal.abort();
  await assert.rejects(client.callTool('get_proxy_status', {}, { signal: aborted }), { code: 'REQUEST_CANCELLED' });
  assert.throws(() => createProxyClient({ home: 'relative' }), /absolute/);
});

test('library returns raw data, isolates task leases and discovers a rotated daemon handshake', async (t) => {
  const seen = [];
  const control = new ControlServer({ port: 0, tools: {
    get_proxy_status: async () => ({ running: true }),
    acquire_capture_lease: async () => ({ capture_lease_id: 'dd2bcf33-8ea5-48ac-981c-3f8688724ace' }),
    mock_json_response: async (args) => { seen.push(args); return { status: 'registered' }; },
    finish_capture_task: async (args) => { seen.push(args); return { lease_released: true }; },
  } });
  await control.start();
  t.after(() => control.stop());
  const first = createProxyClient({ home: directory, readyTimeoutMs: 100 });
  const second = createProxyClient({ home: directory, readyTimeoutMs: 100 });
  assert.deepEqual(await first.callTool('get_proxy_status'), { running: true });
  await first.callTool('acquire_capture_lease', { task_id: 'task' });
  const mock = { url: 'https://fixture.invalid/api', json: {} };
  await first.callTool('mock_json_response', mock);
  await second.callTool('mock_json_response', mock);
  assert.equal(seen[0].capture_lease_id, 'dd2bcf33-8ea5-48ac-981c-3f8688724ace');
  assert.equal(seen[1].capture_lease_id, undefined);
  await first.callTool('finish_capture_task');
  await first.callTool('mock_json_response', mock);
  assert.equal(seen[3].capture_lease_id, undefined);
  await control.stop();
  const replacement = new ControlServer({ port: 0, tools: { get_proxy_status: async () => ({ running: false }) } });
  await replacement.start();
  t.after(() => replacement.stop());
  assert.deepEqual(await first.callTool('get_proxy_status'), { running: false });
});
