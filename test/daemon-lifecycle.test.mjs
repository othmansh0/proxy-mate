import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { callDaemon } from '../src/lib/control.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('real daemon owns one runtime, shuts down cleanly, and recovers after SIGKILL', { timeout: 45_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-daemon-lifecycle-'));
  const children = new Set();
  t.after(async () => {
    for (const child of children) if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    await Promise.all([...children].map((child) => child.finished));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const reservations = [];
  for (let i = 0; i < 3; i++) {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    reservations.push(server);
  }
  const ports = reservations.map((server) => server.address().port);
  await Promise.all(reservations.map((server) => new Promise((resolve) => server.close(resolve))));
  const args = ['src/server.mjs', '--daemon', '--no-routing',
    '--proxy-port', String(ports[0]), '--pac-port', String(ports[1]), '--control-port', String(ports[2])];
  const start = (environment = {}) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, PROXY_MATE_HOME: directory, ...environment }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.errors = '';
    child.stdout.resume();
    child.stderr.on('data', (data) => { child.errors += data; });
    child.finished = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    children.add(child);
    return child;
  };
  const ready = async (child, previousToken) => {
    for (let i = 0; i < 400; i++) {
      if (child.exitCode != null || child.signalCode != null) assert.fail(child.errors);
      try {
        const handshake = JSON.parse(await fs.readFile(path.join(directory, 'handshake.json'), 'utf8'));
        if (handshake.token !== previousToken) {
          const status = await callDaemon({ ...handshake, tool: 'get_proxy_status', timeoutMs: 500 });
          if (status.running) return handshake;
        }
      } catch { /* startup/recovery in progress */ }
      await delay(50);
    }
    assert.fail(`Daemon readiness deadline exceeded: ${child.errors}`);
  };
  const first = start();
  const initial = await ready(first);
  const defaultStatus = await callDaemon({ ...initial, tool: 'get_proxy_status' });
  assert.equal(defaultStatus.simulator_watcher, 'stopped');
  assert.equal(defaultStatus.connection_attempt_timeout_ms, 2000);
  assert.equal(defaultStatus.routing_active, false);
  await callDaemon({ ...initial, tool: 'stop_proxy' });
  await callDaemon({ ...initial, tool: 'create_capture_session', args: { session_id: 'persistent-active', activate: true } });
  await assert.rejects(callDaemon({ ...initial, tool: 'start_app_capture', args: {
    udid: 'not-needed-before-port-check', bundle_id: 'com.example.demo', port: ports[0],
  } }), { code: 'APP_PROXY_PORT_CONFLICT' });
  await callDaemon({ ...initial, tool: 'start_proxy', args: { port: ports[0], auto_setup: false } });
  const clients = [];
  t.after(async () => { await Promise.all(clients.map((client) => client.close())); });
  for (let index = 0; index < 2; index++) {
    const client = new Client({ name: `shared-${index}`, version: '1' });
    clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: ['src/server.mjs', '--require-daemon'], cwd: root,
      env: { ...process.env, PROXY_MATE_HOME: directory }, stderr: 'pipe' }));
    const result = await client.callTool({ name: 'get_proxy_status', arguments: {} });
    assert.equal(result.structuredContent.data.daemon_pid, first.pid);
  }
  await clients[0].close();
  assert.equal((await clients[1].callTool({ name: 'get_proxy_status', arguments: {} })).structuredContent.data.running, true);
  const concurrent = start();
  const denied = await concurrent.finished;
  assert.notEqual(denied.code, 0);
  assert.match(concurrent.errors, /owns this state directory/);
  assert.equal((await callDaemon({ ...initial, tool: 'get_proxy_status' })).running, true);
  const lease = await callDaemon({ ...initial, tool: 'acquire_capture_lease', args: { task_id: 'survive-restart' } });
  first.kill('SIGTERM');
  assert.deepEqual(await first.finished, { code: 0, signal: null });
  await assert.rejects(fs.access(path.join(directory, 'handshake.json')), { code: 'ENOENT' });
  const second = start({ PROXY_MATE_CONNECT_ATTEMPT_TIMEOUT_MS: '1250' });
  const restarted = await ready(second, initial.token);
  assert.equal((await callDaemon({ ...restarted, tool: 'get_proxy_status' })).connection_attempt_timeout_ms, 1250);
  const restoredStatus = await callDaemon({ ...restarted, tool: 'get_proxy_status' });
  assert.equal(restoredStatus.active_session_id, 'persistent-active');
  assert.equal(restoredStatus.capture_lease.task_id, 'survive-restart');
  await assert.rejects(callDaemon({ ...restarted, tool: 'stop_proxy' }), { code: 'CAPTURE_OWNED' });
  assert.equal((await callDaemon({ ...restarted, tool: 'acquire_capture_lease', args: { task_id: 'survive-restart', capture_lease_id: lease.capture_lease_id } })).status, 'renewed');
  second.kill('SIGKILL');
  await second.finished;
  const pendingRead = clients[1].callTool({ name: 'get_proxy_status', arguments: {} });
  await delay(200);
  const recovered = start();
  const finalHandshake = await ready(recovered, restarted.token);
  assert.notEqual(finalHandshake.token, restarted.token);
  const resumed = await pendingRead;
  assert.equal(resumed.isError, undefined);
  assert.equal(resumed.structuredContent.data.daemon_pid, recovered.pid);
  const persisted = JSON.parse(await fs.readFile(path.join(directory, 'state.json'), 'utf8'));
  assert.equal(persisted.pid, recovered.pid);
  assert.ok(!persisted.routing_active);
  recovered.kill('SIGTERM');
  assert.deepEqual(await recovered.finished, { code: 0, signal: null });
});
