import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore, SessionStoreError } from '../src/lib/session-store.mjs';

async function makeStore(options = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-mcp-sessions-'));
  return { rootDir, store: new SessionStore({ rootDir, ...options }) };
}

test('durably appends and updates flows, preserving their stable sequence across cursor pages', async () => {
  const { store } = await makeStore();
  await store.createSession({ id: 'build-123', name: 'Xcode build 123' });
  await store.appendFlow({ sessionId: 'build-123', flow: { id: 'flow-a', request: { url: 'https://a.test' } } });
  await store.appendFlow({ sessionId: 'build-123', flow: { id: 'flow-b', request: { method: 'GET', url: 'https://b.test' } } });
  await store.appendFlow({ sessionId: 'build-123', flow: { id: 'flow-c', request: { url: 'https://c.test' } } });

  const first = await store.listFlows({ sessionId: 'build-123', limit: 2 });
  assert.deepEqual(first.flows.map((flow) => [flow.id, flow.sequence]), [['flow-a', 1], ['flow-b', 2]]);
  assert.ok(first.next_cursor);

  await store.updateFlow({ sessionId: 'build-123', flowId: 'flow-b', patch: { response: { statusCode: 201 } } });
  const second = await store.listFlows({ sessionId: 'build-123', cursor: first.next_cursor, limit: 2 });
  assert.deepEqual(second.flows.map((flow) => [flow.id, flow.sequence]), [['flow-c', 3]]);
  assert.equal((await store.getFlow({ sessionId: 'build-123', flowId: 'flow-b' })).response.statusCode, 201);

  const indexed = await store.listFlows({
    sessionId: 'build-123',
    filters: { host_equals: 'b.test', method: 'get', status_min: 200, status_max: 299 },
  });
  assert.deepEqual(indexed.flows.map((flow) => flow.id), ['flow-b']);

  const since = await store.listFlows({ sessionId: 'build-123', since_flow_id: 'flow-a' });
  assert.deepEqual(since.flows.map((flow) => flow.id), ['flow-b', 'flow-c']);
  await assert.rejects(
    store.listFlows({ sessionId: 'build-123', cursor: 'not-a-cursor' }),
    (error) => error instanceof SessionStoreError && error.code === 'INVALID_CURSOR',
  );
});

test('sessions survive store recreation and are private on disk', async () => {
  const { rootDir, store } = await makeStore();
  await store.createSession({ id: 'durable', name: 'Durable capture' });
  await store.appendFlow({ sessionId: 'durable', flow: { id: 'request-1', body: 'hello' } });

  const reloaded = new SessionStore({ rootDir });
  const page = await reloaded.listFlows({ sessionId: 'durable' });
  assert.equal(page.flows[0].id, 'request-1');
  assert.equal((await fs.stat(rootDir)).mode & 0o077, 0);
  assert.equal((await fs.stat(path.join(rootDir, 'sessions.sqlite3'))).mode & 0o077, 0);
  assert.equal((await reloaded.storageStatus()).journal_mode, 'wal');
});

test('session settings can be renamed, tagged, and retention-updated atomically', async () => {
  const { store } = await makeStore({ retention: { max_flows: 10, max_bytes: 1_000_000, max_age_ms: 1_000_000 } });
  await store.createSession({ id: 'mutable', name: 'Before', metadata: { owner: 'ios', keep: true } });
  await store.appendFlow({ sessionId: 'mutable', flow: { id: 'a' } });
  await store.appendFlow({ sessionId: 'mutable', flow: { id: 'b' } });
  const result = await store.updateSession({
    sessionId: 'mutable', name: 'After', metadata: { tag: 'release' }, retention: { max_flows: 1 },
  });
  assert.equal(result.session.name, 'After');
  assert.deepEqual(result.session.metadata, { owner: 'ios', keep: true, tag: 'release' });
  assert.equal(result.session.retention.max_flows, 1);
  assert.equal(result.session.flow_count, 1);
  assert.deepEqual((await store.listFlows({ sessionId: 'mutable' })).flows.map((flow) => flow.id), ['b']);
});

test('legacy JSON snapshots migrate once into SQLite without losing trusted body paths', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-mcp-legacy-sessions-'));
  const legacy = {
    schema_version: 1,
    id: 'legacy',
    name: 'Legacy capture',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:01.000Z',
    next_sequence: 2,
    retention: { max_flows: 100, max_bytes: 1_000_000, max_age_ms: 99_999_999_999 },
    metadata: { source: 'json' },
    flows: [{
      id: 'legacy-flow', sequence: 1,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:01.000Z',
      request: { url: 'https://legacy.test', body_path: '/private/tmp/legacy-request.bin', body_size: 42 },
    }],
  };
  await fs.writeFile(path.join(rootDir, 'legacy.json'), JSON.stringify(legacy), { mode: 0o600 });

  const store = new SessionStore({ rootDir });
  const flow = await store.getFlow({ sessionId: 'legacy', flowId: 'legacy-flow' });
  assert.equal(flow.request.body_path, '/private/tmp/legacy-request.bin');
  assert.equal((await store.getSession('legacy')).metadata.source, 'json');
  await assert.rejects(fs.stat(path.join(rootDir, 'legacy.json')), { code: 'ENOENT' });
  assert.equal((await fs.stat(path.join(rootDir, 'legacy-json', 'legacy.json'))).mode & 0o077, 0);
});

test('concurrent appends are serialized without lost rows or duplicate sequences', async () => {
  const { store } = await makeStore({ retention: { max_flows: 1_000 } });
  await store.createSession({ id: 'concurrent', name: 'Concurrent capture' });
  await Promise.all(Array.from({ length: 200 }, (_, index) => store.appendFlow({
    sessionId: 'concurrent',
    flow: { id: `flow-${index}`, request: { url: `https://example.test/${index}` } },
  })));
  const page = await store.listFlows({ sessionId: 'concurrent', limit: 500 });
  assert.equal(page.flows.length, 200);
  assert.deepEqual(page.flows.map((flow) => flow.sequence), Array.from({ length: 200 }, (_, index) => index + 1));
  assert.equal((await store.getSession('concurrent')).flow_count, 200);
});

test('corrupt legacy JSON stays recoverable and is reported without blocking valid sessions', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-mcp-corrupt-legacy-'));
  await fs.writeFile(path.join(rootDir, 'damaged.json'), '{not valid json', { mode: 0o600 });
  const store = new SessionStore({ rootDir });
  await store.createSession({ id: 'healthy', name: 'Healthy' });
  const status = await store.storageStatus();
  assert.equal(status.migration_warnings[0].code, 'LEGACY_JSON_NOT_MIGRATED');
  assert.equal(status.migration_warnings[0].file, 'damaged.json');
  assert.equal((await fs.readFile(path.join(rootDir, 'damaged.json'), 'utf8')), '{not valid json');
});

test('a non-SQLite database fails with a machine-actionable corruption error', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-mcp-corrupt-db-'));
  await fs.writeFile(path.join(rootDir, 'sessions.sqlite3'), 'not a sqlite database', { mode: 0o600 });
  const store = new SessionStore({ rootDir });
  await assert.rejects(
    store.init(),
    (error) => error instanceof SessionStoreError && error.code === 'CORRUPT_DATABASE',
  );
});

test('retention enforces max flows, bytes, and age without reusing sequence numbers', async () => {
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const { store } = await makeStore({ clock: () => now, retention: { max_flows: 2, max_bytes: 10_000, max_age_ms: 100 } });
  await store.createSession({ id: 'retain', name: 'Retention' });
  await store.appendFlow({ sessionId: 'retain', flow: { id: 'old', created_at: new Date(now - 101).toISOString() } });
  await store.appendFlow({ sessionId: 'retain', flow: { id: 'new-a', message: 'a' } });
  await store.appendFlow({ sessionId: 'retain', flow: { id: 'new-b', message: 'b' } });
  let page = await store.listFlows({ sessionId: 'retain' });
  assert.deepEqual(page.flows.map((flow) => [flow.id, flow.sequence]), [['new-a', 2], ['new-b', 3]]);

  now += 101;
  await store.appendFlow({ sessionId: 'retain', flow: { id: 'latest', message: 'x'.repeat(500) } });
  page = await store.listFlows({ sessionId: 'retain' });
  assert.deepEqual(page.flows.map((flow) => [flow.id, flow.sequence]), [['latest', 4]]);

  const byteStore = (await makeStore({ retention: { max_flows: 10, max_bytes: 300, max_age_ms: 1_000_000 } })).store;
  await byteStore.createSession({ id: 'bytes', name: 'Byte retention' });
  await byteStore.appendFlow({ sessionId: 'bytes', flow: { id: 'one', payload: 'a'.repeat(180) } });
  await byteStore.appendFlow({ sessionId: 'bytes', flow: { id: 'two', payload: 'b'.repeat(180) } });
  assert.deepEqual((await byteStore.listFlows({ sessionId: 'bytes' })).flows.map((flow) => flow.id), ['two']);
});

test('purge and portable import/export remove unsafe local body paths', async () => {
  const { store } = await makeStore();
  await store.createSession({ id: 'source', name: 'Source' });
  await store.appendFlow({ sessionId: 'source', flow: {
    id: 'captured', request: { body_path: '/private/tmp/request.bin' }, response: { body_path: '/private/tmp/response.bin' },
  } });
  const portable = await store.exportSession('source');
  assert.equal(portable.format, 'proxy-mcp.session/v1');
  assert.equal(portable.session.flows[0].request.body_path, undefined);
  assert.equal(portable.session.flows[0].response.body_path, undefined);

  const imported = await store.importSession({ document: portable, sessionId: 'copy', name: 'Imported' });
  assert.equal(imported.flow_count, 1);
  const unsafeDocument = structuredClone(portable);
  unsafeDocument.session.flows[0].request.body_path = '/etc/passwd';
  await store.importSession({ document: unsafeDocument, sessionId: 'safe-copy' });
  assert.equal((await store.getFlow({ sessionId: 'safe-copy', flowId: 'captured' })).request.body_path, undefined);
  assert.equal((await store.purgeFlows({ sessionId: 'copy', before_sequence: 2 })).purged, 1);
  assert.equal(await store.purgeSession('copy'), true);
  assert.equal(await store.getSession('copy'), null);
});
