import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as mockttp from 'mockttp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

process.env.PROXY_MCP_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-reliability-'));
const { ProxyEngine, ensureCA, validateCA } = await import('../src/lib/proxy.mjs');
const { ControlServer, callDaemon, rpcTimeoutFor } = await import('../src/lib/control.mjs');
const { readHandshake, writeState, readState } = await import('../src/lib/state.mjs');
const { clearPacRouting, PacServer } = await import('../src/lib/pac.mjs');
const { watchSimulators, inspectCertificate } = await import('../src/lib/sim.mjs');
const { WebSocketStore } = await import('../src/lib/websocket-store.mjs');
const { plistXml, waitForDaemonReady } = await import('../src/lib/launchagent.mjs');
const { makeTools } = await import('../src/lib/tools.mjs');
const execFileP = promisify(execFile);

async function eventually(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise((r) => setTimeout(r, 20)); }
  assert.fail('Condition did not become true before deadline');
}

function request(port, target, body = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: target, method: 'POST' }, (res) => {
      const parts = []; res.on('data', (part) => parts.push(part));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(parts).toString() }));
    });
    req.on('error', reject); req.end(body);
  });
}

test('traffic capture does not keep Mockttp unbounded request history', async (t) => {
  const engine = new ProxyEngine({ sessionId: 'bounded-traffic' });
  await engine.start({ port: 0 }); t.after(() => engine.stop());
  await engine.registerRule({ rule_id: 'bounded', url: 'http://bounded.test/*', body: 'ok', status: 200, type: 'map_local' });
  for (let index = 0; index < 100; index++) assert.equal((await request(engine.port, 'http://bounded.test/data', 'x'.repeat(8192))).status, 200);
  await eventually(() => engine.flows.size === 100 && engine.captureWork.size === 0);
  const endpoints = await engine.server.getMockedEndpoints();
  for (const endpoint of endpoints) assert.deepEqual(await endpoint.getSeenRequests(), []);
  assert.ok([...engine.flows.values()].every((flow) => flow.request && flow.response));
});

test('simultaneous start calls share one listener and repeated start does not rebuild live rules', async (t) => {
  const engine = new ProxyEngine({ sessionId: 'concurrent-start' });
  t.after(() => engine.stop());
  const results = await Promise.all([engine.start({ port: 0 }), engine.start({ port: 0 })]);
  assert.equal(results[0].port, results[1].port);
  assert.equal(results[1].status, 'already_running');
  await engine.registerRule({ rule_id: 'in-memory', url: 'http://in-memory.test/*', body: 'kept', status: 200, type: 'map_local' });
  const endpoint = engine.mockRules.get('in-memory').endpoint;
  const tools = makeTools({ engine, pacServer: new PacServer() });
  assert.equal((await tools.start_proxy()).status, 'already_running');
  assert.equal(engine.mockRules.get('in-memory').endpoint, endpoint);
});

test('CA mismatch and incomplete CA fail without silently replacing trust', async () => {
  const stable = await ensureCA();
  const original = await fs.readFile(stable.certPath);
  const other = await mockttp.generateCACertificate();
  const key = path.join(process.env.PROXY_MCP_HOME, 'other-key.pem');
  await fs.writeFile(key, other.key);
  await assert.rejects(validateCA(key, stable.certPath), { code: 'CA_KEY_MISMATCH' });
  const savedKey = await fs.readFile(stable.keyPath);
  await fs.unlink(stable.keyPath);
  try { await assert.rejects(ensureCA(), { code: 'CA_INCOMPLETE' }); }
  finally { await fs.writeFile(stable.keyPath, savedKey, { mode: 0o600 }); }
  assert.deepEqual(await fs.readFile(stable.certPath), original);
});

test('DER staging leaves a custom certificate and sibling files unchanged', async () => {
  const { certPath } = await ensureCA();
  const original = await fs.readFile(certPath);
  const custom = path.join(process.env.PROXY_MCP_HOME, 'custom'); await fs.mkdir(custom);
  await fs.writeFile(path.join(custom, 'custom.pem'), original);
  await fs.writeFile(path.join(custom, 'cert.der'), 'user-owned');
  const inspected = await inspectCertificate(path.join(custom, 'custom.pem'));
  assert.equal(inspected.ok, true);
  assert.equal(await fs.readFile(path.join(custom, 'cert.der'), 'utf8'), 'user-owned');
  assert.ok(inspected.der_path.includes(inspected.fingerprint_sha256));
});

test('watcher survives repeated tooling failures and stops without further callbacks', async (t) => {
  let calls = 0; const reports = [];
  const stop = watchSimulators({ interval: 2000, list: async () => { calls++; throw new Error('CoreSimulator restarting'); }, onResult: (result) => reports.push(result) });
  t.after(stop);
  await eventually(() => calls >= 2, 4000);
  await stop();
  assert.ok(reports.every((result) => result.status === 'watcher_error'));
  const count = reports.length;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(reports.length, count);
});

test('WebSocket persistence coalesces bursts while disk is slow', async () => {
  let release; const blocked = new Promise((resolve) => { release = resolve; });
  const snapshots = [];
  const store = new WebSocketStore({ backend: { save: async (snapshot) => { snapshots.push(snapshot); await blocked; } } });
  store.onRequest({ id: 'stream', url: 'ws://stream.test' });
  await eventually(() => snapshots.length === 1);
  for (let i = 0; i < 2000; i++) store.onMessageSent({ id: 'stream', content: Buffer.from(String(i)), isBinary: false });
  assert.equal(snapshots.length, 1);
  release(); await store.flush();
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1].connections[0].next_message_sequence, 2001);
});

test('WebSocket disk errors are reported by flush without an unhandled rejection', async () => {
  const store = new WebSocketStore({ backend: { save: async () => { throw new Error('disk full'); } } });
  store.onRequest({ id: 'stream' });
  await new Promise((r) => setImmediate(r));
  await assert.rejects(store.flush(), /disk full/);
});

test('WebSocket memory budget applies across connections and imported snapshots', () => {
  const store = new WebSocketStore({ maxTotalMessageBytes: 2048 });
  for (let i = 0; i < 10; i++) store.onMessageSent({ id: `stream-${i}`, content: 'x'.repeat(512), isBinary: false });
  assert.ok(store.retainedMessageBytes <= 2048);
  assert.ok(store.exportSnapshot().connections.reduce((count, c) => count + c.dropped_message_count, 0) > 0);
  const restored = new WebSocketStore({ maxTotalMessageBytes: 1024 });
  restored.importSnapshot(store.exportSnapshot());
  assert.ok(restored.retainedMessageBytes <= 1024);
});

test('malformed RPC values and inherited methods do not crash the control server', async (t) => {
  const control = new ControlServer({ port: 0, tools: { echo: async (args) => args, start_proxy: async () => ({}) } });
  await control.start(); t.after(() => control.stop());
  const handshake = await readHandshake();
  for (const payload of [null, [], 42, { tool: 'echo', args: [] }, { tool: 'toString' }, { tool: 'constructor' }, { tool: 'start_proxy', args: { port: -1 } }]) {
    const response = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: control.port, path: '/rpc', method: 'POST', headers: { authorization: `Bearer ${handshake.token}` } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end(JSON.stringify(payload));
    });
    assert.ok(response >= 400);
  }
  assert.deepEqual(await callDaemon({ ...handshake, tool: 'echo', args: { alive: true } }), { alive: true });
  assert.ok(rpcTimeoutFor('wait_for_flow', { timeout_ms: 120_000 }) > 120_000);
  assert.ok(rpcTimeoutFor('setup_simulator_certificate') > 180_000);
});

test('control shutdown cancels pending operations and preserves a newer handshake', async () => {
  let started; const entered = new Promise((resolve) => { started = resolve; });
  const first = new ControlServer({ port: 0, tools: { wait: async (_args, { signal }) => new Promise((_, reject) => { started(); signal.addEventListener('abort', () => reject(signal.reason)); }) } });
  await first.start(); const old = await readHandshake();
  const second = new ControlServer({ port: 0, tools: {} }); await second.start();
  const current = await readHandshake();
  const pending = callDaemon({ ...old, tool: 'wait' }); const rejected = assert.rejects(pending);
  await entered; await first.stop(); await rejected;
  assert.equal((await readHandshake()).token, current.token);
  await second.stop();
});

test('routing restores exact prior disabled settings and retains failed recovery', async () => {
  const state = { pid: process.pid, routing_active: true, network_service: 'Test', pac_url: 'http://127.0.0.1:8081/proxy.pac', prior_auto_proxy: { enabled: false, url: 'http://old.test/pac' } };
  await writeState(state);
  const commands = [];
  const run = async (_file, args) => { commands.push(args); return { stdout: 'URL: http://127.0.0.1:8081/proxy.pac\nEnabled: Yes\n' }; };
  assert.equal((await clearPacRouting({ run })).status, 'restored');
  assert.deepEqual(commands.slice(1), [['-setautoproxyurl', 'Test', 'http://old.test/pac'], ['-setautoproxystate', 'Test', 'off']]);
  await writeState(state);
  await assert.rejects(clearPacRouting({ run: async (_f, args) => { if (args[0].startsWith('-set')) throw new Error('denied'); return run(_f, args); } }), /denied/);
  assert.equal((await readState()).routing_active, true);
  assert.equal((await clearPacRouting({ run: async () => ({ stdout: 'URL: http://vpn.test/pac\nEnabled: Yes\n' }) })).status, 'changed_externally');
});

test('unowned or inactive routing never triggers a network mutation', async () => {
  await writeState({ pid: process.pid + 100, routing_active: true, network_service: 'Other' });
  const run = async () => assert.fail('must not execute networksetup');
  await assert.rejects(clearPacRouting({ run }), { code: 'ROUTING_OWNED' });
  await writeState({ routing_active: false, network_service: 'Other' });
  assert.equal((await clearPacRouting({ run })).status, 'not_active');
});

test('LaunchAgent specifies state, working directory, restart policy and verified readiness', async () => {
  const plist = plistXml({ programArgs: ['/opt/homebrew/bin/node', '/tmp/A&B/src/server.mjs', '--daemon'], environment: { PROXY_MCP_MAX_FLOWS: '100' } });
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>WorkingDirectory<\/key>\s*<string>\/tmp\/A&amp;B<\/string>/);
  assert.match(plist, /PROXY_MCP_HOME/);
  await assert.rejects(waitForDaemonReady({ timeoutMs: 10, previousToken: 'old', read: async () => ({ token: 'old' }), probe: async () => true }), { code: 'DAEMON_STARTUP_TIMEOUT' });
  assert.equal(await waitForDaemonReady({ read: async () => ({ token: 'new' }), probe: async () => true }), true);
});

test('invalid CLI flags fail promptly instead of entering stdio or truncating numbers', async () => {
  for (const args of [['--bogus'], ['instal'], ['--proxy-port', '8080oops'], ['--domains'], ['--daemon', 'status']]) {
    await assert.rejects(execFileP(process.execPath, ['src/server.mjs', ...args], { timeout: 3000, cwd: path.resolve(import.meta.dirname, '..') }), (error) => error.code === 1 && !error.killed);
  }
});

test('stdio EOF exits even after an in-process listener has been started', async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-stdio-eof-'));
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, PROXY_MCP_HOME: state }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let output = ''; let errors = '';
  child.stdout.on('data', (data) => { output += data; }); child.stderr.on('data', (data) => { errors += data; });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }) + '\n');
  await eventually(() => output.includes('"id":1'));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  // Operator UI gives this process a live socket without changing macOS routing.
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'start_operator_ui', arguments: { port: 0 } } }) + '\n');
  await eventually(() => output.includes('"id":2'));
  const result = output.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((message) => message.id === 2);
  assert.equal(result.result.isError, undefined, errors);
  child.stdin.end();
  await eventually(() => child.exitCode !== null);
  assert.equal(await exited, 0, errors);
});

test('an existing MCP client reconnects after daemon address and token rotation', async (t) => {
  // Keep the MCP transport alive while replacing the daemon's control server.
  const first = new ControlServer({ port: 0, tools: { get_version: async () => ({ version: 'first' }) } });
  await first.start();
  t.after(() => first.stop());
  const transport = new StdioClientTransport({ command: process.execPath, args: ['src/server.mjs'],
    cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env }, stderr: 'pipe' });
  const client = new Client({ name: 'restart-test', version: '1' });
  await client.connect(transport); t.after(() => client.close());
  assert.equal((await client.callTool({ name: 'get_version', arguments: {} })).structuredContent.data.version, 'first');
  await first.stop();
  const unavailable = await client.callTool({ name: 'get_version', arguments: {} });
  assert.equal(unavailable.isError, true);
  assert.equal(unavailable.structuredContent.error.code, 'DAEMON_UNAVAILABLE');
  const second = new ControlServer({ port: 0, tools: { get_version: async () => ({ version: 'second' }) } });
  await second.start(); t.after(() => second.stop());
  assert.equal((await client.callTool({ name: 'get_version', arguments: {} })).structuredContent.data.version, 'second');
  await client.close();
  assert.equal((await callDaemon({ ...await readHandshake(), tool: 'get_version' })).version, 'second');
});
