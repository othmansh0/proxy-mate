import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveStateDirectory } from '../src/lib/config.mjs';
import { readEnvironment, serviceEnvironment } from '../src/lib/environment.mjs';
import { connectionAttemptTimeout } from '../src/lib/network-policy.mjs';
import { createRedactor } from '../src/lib/redaction.mjs';
import { clientRegistrationPlan, registerClient } from '../src/lib/client-registration.mjs';
import { SessionStore } from '../src/lib/session-store.mjs';
import { PluginStore } from '../src/lib/plugin-store.mjs';
import { WebSocketStore, buildWebSocketReplayPlan } from '../src/lib/websocket-store.mjs';

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-mate-compat-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('rename reuses legacy state in place and gives explicit new configuration precedence', () => {
  const home = '/example/home';
  const legacy = path.join(home, '.proxy-mcp');
  assert.equal(resolveStateDirectory({ home, env: {}, exists: () => false }), path.join(home, '.proxy-mate'));
  assert.equal(resolveStateDirectory({ home, env: {}, exists: (file) => file === legacy }), legacy);
  assert.equal(resolveStateDirectory({ home, env: { PROXY_MCP_HOME: '/old' } }), '/old');
  assert.equal(resolveStateDirectory({ home, env: { PROXY_MCP_HOME: '/old', PROXY_MATE_HOME: '/new' } }), '/new');
  const env = { PROXY_MCP_ALLOW_SENSITIVE: '1', PROXY_MATE_ALLOW_SENSITIVE: '0',
    PROXY_MCP_REDACT_HEADERS: 'x-private', PROXY_MCP_CONNECT_ATTEMPT_TIMEOUT_MS: '2500' };
  const before = { ...env };
  assert.equal(readEnvironment('PROXY_MATE_ALLOW_SENSITIVE', env), '0');
  assert.equal(connectionAttemptTimeout(env), 2500);
  assert.deepEqual(createRedactor({ env }).redactHeaders({ 'x-private': 'secret' }), { 'x-private': '[REDACTED]' });
  assert.deepEqual(serviceEnvironment(env), { PROXY_MATE_ALLOW_SENSITIVE: '0',
    PROXY_MATE_REDACT_HEADERS: 'x-private', PROXY_MATE_CONNECT_ATTEMPT_TIMEOUT_MS: '2500' });
  assert.deepEqual(env, before);
});

test('JSON setup retires an owned legacy bridge once and preserves custom servers', async (t) => {
  const home = await temporary(t);
  const plan = await clientRegistrationPlan({ client: 'claude', home, stateDir: path.join(home, 'state'), env: {} });
  const legacy = { ...plan.entry, env: { PROXY_MCP_HOME: plan.entry.env.PROXY_MATE_HOME } };
  const original = JSON.stringify({ theme: 'dark', mcpServers: { 'proxy-mcp': legacy, other: { command: 'custom' } } });
  await fs.writeFile(plan.config_path, original);
  const result = await registerClient(plan);
  const config = JSON.parse(await fs.readFile(plan.config_path, 'utf8'));
  assert.equal(config.mcpServers['proxy-mcp'], undefined);
  assert.deepEqual(config.mcpServers['proxy-mate'], plan.entry);
  assert.deepEqual(config.mcpServers.other, { command: 'custom' });
  assert.equal(await fs.readFile(result.backup_path, 'utf8'), original);
  assert.equal((await registerClient(plan)).status, 'unchanged');
  await fs.writeFile(plan.config_path, JSON.stringify({ mcpServers: { 'proxy-mcp': { command: 'custom' } } }));
  await registerClient(plan);
  assert.deepEqual(JSON.parse(await fs.readFile(plan.config_path, 'utf8')).mcpServers['proxy-mcp'], { command: 'custom' });
});

test('Codex setup installs the replacement before retiring legacy and isolates CODEX_HOME', async (t) => {
  const home = await temporary(t);
  const plan = { client: 'codex', config_path: path.join(home, 'config.toml'), backup_dir: path.join(home, 'backups'),
    executable: '/fake/codex', arguments: ['mcp', 'add', 'proxy-mate'],
    entry: { command: '/node', args: ['/state/runtime/current/src/client.mjs'] } };
  await fs.writeFile(plan.config_path, 'original');
  const calls = [];
  const run = async (_command, args, options) => {
    assert.equal(options.env.CODEX_HOME, home);
    calls.push(args);
    return { stdout: JSON.stringify({ transport: plan.entry }) };
  };
  await registerClient(plan, { run });
  assert.deepEqual(calls.map((args) => args.slice(0, 3)), [
    ['mcp', 'get', 'proxy-mcp'], ['mcp', 'add', 'proxy-mate'], ['mcp', 'remove', 'proxy-mcp'],
  ]);
  calls.length = 0;
  await assert.rejects(registerClient(plan, { run: async (...args) => {
    if (args[1][1] === 'add') throw new Error('failed add');
    return run(...args);
  } }), /Codex registration failed/);
  assert.equal(calls.some((args) => args[1] === 'remove'), false);
});

test('legacy session exports and plugin catalogs remain readable after rename', async (t) => {
  const home = await temporary(t);
  const sessions = new SessionStore({ rootDir: path.join(home, 'sessions') });
  t.after(() => sessions.close());
  await sessions.createSession({ id: 'source' });
  await sessions.appendFlow({ sessionId: 'source', flow: { id: 'flow-1', request: { url: 'https://example.test' } } });
  const document = await sessions.exportSession('source');
  assert.equal(document.format, 'proxy-mate.session/v1');
  document.format = 'proxy-mcp.session/v1';
  await sessions.importSession({ document, sessionId: 'imported' });
  assert.equal((await sessions.getFlow({ sessionId: 'imported', flowId: 'flow-1' })).request.url, 'https://example.test');
  const directory = path.join(home, 'plugins');
  const plugins = new PluginStore({ directory });
  await plugins.upsert({ id: 'existing', stage: 'response', enabled: true, source: '(value) => value' });
  plugins.dispose();
  const catalogPath = path.join(directory, 'plugins.json');
  const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
  catalog.format = 'proxy-mcp.plugin-store/v1';
  await fs.writeFile(catalogPath, JSON.stringify(catalog));
  const restored = new PluginStore({ directory });
  t.after(() => restored.dispose());
  assert.equal((await restored.init()).restored, 1);
  assert.deepEqual(await restored.execute({ id: 'existing', stage: 'response', input: { ok: true } }), { ok: true });
});

test('legacy WebSocket snapshots and transcripts retain replay data', () => {
  const store = new WebSocketStore();
  store.onRequest({ id: 'socket-1', url: 'wss://example.test/socket' });
  const snapshot = store.exportSnapshot();
  snapshot.format = 'proxy-mcp.websocket-store/v1';
  const restored = new WebSocketStore();
  assert.equal(restored.importSnapshot(snapshot).imported, 1);
  const transcript = restored.exportTranscript({ connectionId: 'socket-1' });
  transcript.format = 'proxy-mcp.websocket-transcript/v1';
  const other = new WebSocketStore();
  other.importTranscript(transcript);
  assert.equal(buildWebSocketReplayPlan(transcript).connection_id, 'socket-1');
});
