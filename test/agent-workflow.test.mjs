import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mergeJsonPatch } from '../src/lib/agent-json.mjs';
import { rotateDaemonLogs } from '../src/lib/log-maintenance.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function listen(server) { await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
async function request(port, url) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: url }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.setTimeout(10000, () => req.destroy(new Error('fixture request timeout')));
  });
}

test('agent uses real MCP to mock JSON, patch it under load, capture, and resolve request/response breakpoints', { timeout: 30_000 }, async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-agent-e2e-'));
  const reservation = http.createServer();
  const proxyPort = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const upstream = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ source: 'upstream', pad: 'x'.repeat(70000) })); });
  const upstreamPort = await listen(upstream);
  const client = new Client({ name: 'agent-workflow-regression', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src/server.mjs')], cwd: root,
    env: { ...process.env, PROXY_MCP_HOME: state }, stderr: 'pipe' });
  let stderr = '';
  t.after(async () => { await client.close(); upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); await fs.rm(state, { recursive: true, force: true }); });
  await client.connect(transport);
  transport.stderr?.on('data', (data) => { stderr += data; });
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    assert.ok(!response.isError, `${name}: ${JSON.stringify(response.structuredContent?.error ?? response.content)} ${stderr}`);
    return response.structuredContent.data;
  };
  await call('start_proxy', { port: proxyPort, auto_setup: false });
  const url = `http://127.0.0.1:${upstreamPort}/orders?page=2`;
  await call('mock_json_response', { rule_id: 'agent-orders', url, json: { revision: 0, user: { name: 'fixture', remove: true }, items: [1], access_token: 'intentional-fake-fixture-token' } });
  await call('patch_mock_json', { rule_id: 'agent-orders', patch: { user: { remove: null }, items: [2, 3] } });
  assert.deepEqual(JSON.parse((await request(proxyPort, url)).text), { revision: 0, user: { name: 'fixture' }, items: [2, 3], access_token: 'intentional-fake-fixture-token' });
  await Promise.all([
    ...Array.from({ length: 4 }, async () => { for (let i = 0; i < 40; i++) {
      const response = await request(proxyPort, url);
      assert.equal(response.status, 200); assert.equal(typeof JSON.parse(response.text).revision, 'number');
    } }),
    (async () => { for (let i = 1; i <= 15; i++) await call('patch_mock_json', { rule_id: 'agent-orders', patch: { revision: i } }); })(),
  ]);
  const capturedUrl = `http://127.0.0.1:${upstreamPort}/capture`;
  await request(proxyPort, capturedUrl);
  let flow;
  for (let i = 0; i < 100 && !flow; i++) { flow = (await call('get_flows', { limit: 20 })).flows.find((f) => f.url === capturedUrl && f.status === 200); if (!flow) await delay(20); }
  assert.ok(flow);
  await call('capture_to_mock', { flow_id: flow.id, rule_id: 'captured-json', json_merge_patch: { source: 'mocked', pad: null } });
  assert.deepEqual(JSON.parse((await request(proxyPort, capturedUrl)).text), { source: 'mocked' });
  for (const direction of ['request', 'response']) {
    const target = `http://127.0.0.1:${upstreamPort}/${direction}`;
    await call('create_breakpoint', { rule_id: `agent-${direction}`, url: target, direction, timeout_ms: 10000 });
    const responsePromise = request(proxyPort, target);
    let pending;
    for (let i = 0; i < 100 && !pending; i++) { pending = (await call('list_pending_breakpoints', { direction })).breakpoints[0]; if (!pending) await delay(10); }
    assert.ok(pending);
    await call('patch_mock_json', { rule_id: 'agent-orders', patch: { unrelated: true } });
    assert.equal((await call('list_pending_breakpoints', { direction })).breakpoints[0].id, pending.id);
    await call('resolve_breakpoint', { breakpoint_id: pending.id, action: direction === 'request' ? 'respond' : 'modify',
      [direction === 'request' ? 'response' : 'changes']: { statusCode: 202, headers: { 'content-type': 'application/json' }, json: { edited: direction } } });
    const response = await responsePromise;
    assert.equal(response.status, 202); assert.deepEqual(JSON.parse(response.text), { edited: direction });
    await call('remove_rule', { rule_id: `agent-${direction}` });
  }
  const diagnostics = await call('get_diagnostics');
  assert.equal(diagnostics.persistence_health.ok, true);
  assert.equal(diagnostics.capture_dropped_events, 0);
  await call('remove_rule', { rule_id: 'agent-orders' });
  await call('remove_rule', { rule_id: 'captured-json' });
});

test('JSON merge keeps prototype-shaped members inert', () => {
  const result = mergeJsonPatch({}, JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1}}'));
  assert.equal(Object.getPrototypeOf(result), null);
  assert.equal({}.polluted, undefined);
  assert.equal(JSON.parse(JSON.stringify(result)).__proto__.polluted, true);
});

test('log retention preserves the open inode, keeps bounded archives and recovers interrupted staging', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-log-test-'));
  try {
    const file = path.join(directory, 'daemon.err.log');
    await fs.writeFile(file, '0123456789abcdef');
    await fs.writeFile(`${file}.rotating`, 'old interrupted snapshot');
    const inode = (await fs.stat(file)).ino;
    assert.equal(rotateDaemonLogs({ directory, maxBytes: 8, archives: 2 })[0].archived_bytes, 8);
    assert.equal((await fs.stat(file)).ino, inode);
    assert.equal(await fs.readFile(`${file}.1`, 'utf8'), '89abcdef');
    for (let i = 0; i < 4; i++) { await fs.appendFile(file, 'xxxxxxxx'); rotateDaemonLogs({ directory, maxBytes: 8, archives: 2 }); }
    assert.equal((await fs.readdir(directory)).filter((name) => /\.\d+$/.test(name)).length, 2);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
