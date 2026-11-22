import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('required-daemon clients report an outage without claiming a local runtime or disconnecting', { timeout: 25_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-required-daemon-'));
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  for (let index = 0; index < 2; index++) {
    const client = new Client({ name: `unavailable-${index}`, version: '1' });
    clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: ['src/server.mjs', '--require-daemon'], cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, PROXYFAN_HOME: directory }, stderr: 'pipe' }));
  }
  const results = await Promise.all(clients.map((client) => client.callTool({ name: 'get_proxy_status', arguments: {} })));
  for (const result of results) {
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'DAEMON_UNAVAILABLE');
    assert.equal(result.structuredContent.error.retryable, true);
    assert.ok(result.structuredContent.error.recovery.length > 0);
  }
  for (const name of ['runtime.lock', 'state.json', 'handshake.json']) {
    await assert.rejects(fs.access(path.join(directory, name)), { code: 'ENOENT' });
  }
  for (const client of clients) assert.ok((await client.listTools()).tools.length > 0);
});
