import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  WebSocketStore,
  WebSocketStoreError,
  mockttpWebSocketHandlers,
  redactWebSocketHeaders,
  redactWebSocketText,
  redactWebSocketUrl,
  buildWebSocketReplayPlan,
  JsonlWebSocketStoreBackend,
} from '../src/lib/websocket-store.mjs';

test('records Mockttp-shaped lifecycle events using a stable connection id', () => {
  const store = new WebSocketStore();
  const timingEvents = { startTime: Date.parse('2026-01-01T00:00:00.000Z'), startTimestamp: 1_000, wsAcceptedTimestamp: 1_010 };
  store.onRequest({ id: 'ws-1', method: 'GET', url: 'wss://api.example.test/socket?token=private', headers: { Authorization: 'Bearer private', Upgrade: 'websocket' }, timingEvents });
  store.onAccepted({ id: 'ws-1', statusCode: 101, headers: { 'set-cookie': 'sid=private' }, timingEvents });
  store.onMessageReceived({ streamId: 'ws-1', content: Buffer.from('{"kind":"hello","token":"private"}'), isBinary: false, eventTimestamp: 1_020, timingEvents });
  store.onMessageSent({ streamId: 'ws-1', content: Buffer.from([0, 1, 2]), isBinary: true });
  store.onError({ streamId: 'ws-1', error: Object.assign(new Error('peer reset'), { code: 'ECONNRESET' }) });
  store.onClose({ streamId: 'ws-1', closeCode: 1006, closeReason: 'reset', wasClean: false });

  const connection = store.getConnection({ connectionId: 'ws-1' });
  assert.equal(connection.id, 'ws-1');
  assert.equal(connection.state, 'closed');
  assert.equal(connection.request.url, 'wss://api.example.test/socket?token=%5BREDACTED%5D');
  assert.equal(connection.request.headers.Authorization, '[REDACTED]');
  assert.equal(connection.accepted.headers['set-cookie'], '[REDACTED]');
  assert.equal(connection.error.code, 'ECONNRESET');
  assert.equal(connection.close.code, 1006);
  assert.equal(connection.opened_at, '2026-01-01T00:00:00.010Z');

  const page = store.listMessages({ connectionId: 'ws-1' });
  assert.deepEqual(page.messages.map((message) => [message.sequence, message.direction]), [[1, 'received'], [2, 'sent']]);
  assert.equal(page.messages[0].data.text, '{"kind":"hello","token":"[REDACTED]"}');
  assert.equal(page.messages[0].timestamp, '2026-01-01T00:00:00.020Z');
  assert.deepEqual(page.messages[1].data, {
    type: 'binary', byte_size: 3, stored_byte_size: 3, truncated: false,
    sha256: 'ae4b3280e56e2faf83f414a6e3dabe9d5fbe18976544c05fed121accb85b53fc',
    omitted: true,
    omission_reason: 'binary WebSocket payload requires include_sensitive=true and the server-level sensitive-data grant',
  });
  assert.equal(store.listMessages({ connectionId: 'ws-1', includeSensitive: true }).messages[1].data.base64, 'AAEC');
  assert.equal(store.getConnection({ connectionId: 'ws-1', includeSensitive: true }).request.headers.Authorization, 'Bearer private');
  assert.equal(store.listMessages({ connectionId: 'ws-1', includeSensitive: true }).messages[0].data.text, '{"kind":"hello","token":"private"}');
});

test('uses a bounded ring and cursor paging without reusing message sequences', () => {
  const store = new WebSocketStore({ maxMessagesPerConnection: 2 });
  store.onRequest({ id: 'ring', url: 'wss://ring.test' });
  store.onMessageReceived({ id: 'ring', data: 'one' });
  store.onMessageReceived({ id: 'ring', data: 'two' });
  const first = store.listMessages({ connectionId: 'ring', limit: 1 });
  assert.equal(first.messages[0].sequence, 1);
  store.onMessageSent({ id: 'ring', data: 'three' });
  const after = store.listMessages({ connectionId: 'ring', cursor: first.next_cursor });
  assert.deepEqual(after.messages.map((message) => [message.sequence, message.direction]), [[2, 'received'], [3, 'sent']]);
  assert.equal(after.dropped_message_count, 1);
  assert.equal(after.first_available_sequence, 2);
  assert.equal(after.cursor_expired, false);
  const expired = store.listMessages({ connectionId: 'ring', cursor: Buffer.from(JSON.stringify({ id: 'ring', sequence: 0 })).toString('base64url') });
  assert.equal(expired.cursor_expired, true);
  assert.throws(() => store.listMessages({ connectionId: 'ring', cursor: 'bad' }), (error) => error instanceof WebSocketStoreError && error.code === 'INVALID_CURSOR');
});

test('makes binary and oversized messages explicit and supports direction/content filters', () => {
  const store = new WebSocketStore({ maxMessageBytes: 4 });
  store.onRequest({ id: 'filter', url: 'wss://filter.test' });
  store.onMessageReceived({ id: 'filter', data: 'abcdefgh' });
  store.onMessageSent({ id: 'filter', data: 'need more data' });
  store.onMessageReceived({ id: 'filter', data: Buffer.from([1, 2, 3, 4, 5]), isBinary: true });
  const sent = store.listMessages({ connectionId: 'filter', direction: 'sent', contains: 'need', includeSensitive: true });
  assert.equal(sent.messages.length, 1);
  const first = store.listMessages({ connectionId: 'filter', includeSensitive: true }).messages[0];
  assert.deepEqual(first.data, {
    type: 'text', byte_size: 8, stored_byte_size: 4, truncated: true,
    sha256: '9c56cc51b374c3ba189210d5b6d4bf57790d351c96c47c02190ecf1e430635ab', text: 'abcd',
  });
  const binary = store.listMessages({ connectionId: 'filter' }).messages[2];
  assert.equal(binary.data.type, 'binary');
  assert.equal(binary.data.base64, undefined);
  assert.equal(binary.data.omitted, true);
  assert.equal(binary.data.byte_size, 5);
  assert.equal(binary.data.truncated, true);
});

test('exposes an event-handler mapping and evicts old connections as a bounded store', () => {
  const store = new WebSocketStore({ maxConnections: 1 });
  const handlers = mockttpWebSocketHandlers(store);
  assert.deepEqual(Object.keys(handlers), [
    'websocket-request', 'websocket-accepted', 'websocket-message-received', 'websocket-message-sent', 'websocket-close',
  ]);
  handlers['websocket-request']({ id: 'old', url: 'ws://old.test' });
  handlers['websocket-request']({ id: 'new', url: 'ws://new.test' });
  assert.equal(store.getConnection({ connectionId: 'old' }), null);
  assert.equal(store.listConnections({ url_contains: 'new' }).connections[0].id, 'new');
});

test('redaction helpers cover headers, URL query secrets, JSON, and plain text', () => {
  assert.deepEqual(redactWebSocketHeaders({ authorization: 'a', accept: 'application/json' }), { authorization: '[REDACTED]', accept: 'application/json' });
  assert.equal(redactWebSocketUrl('wss://a.test/x?api_key=x&ok=y'), 'wss://a.test/x?api_key=%5BREDACTED%5D&ok=y');
  assert.equal(redactWebSocketText('{"password":"x","safe":"y"}'), '{"password":"[REDACTED]","safe":"y"}');
  assert.equal(redactWebSocketText('Bearer abc token=xyz'), 'Bearer [REDACTED] token=[REDACTED]');
});

test('exports/imports durable snapshots and produces data-only replay plans', () => {
  const store = new WebSocketStore({ maxMessagesPerConnection: 2 });
  store.onRequest({ id: 'saved', url: 'wss://saved.test' }); store.onMessageReceived({ id: 'saved', data: 'one' }); store.onMessageSent({ id: 'saved', data: 'two' }); store.onMessageReceived({ id: 'saved', data: 'three' });
  const snapshot = store.exportSnapshot(); const restored = new WebSocketStore({ maxMessagesPerConnection: 2 }); restored.importSnapshot(snapshot);
  const page = restored.listMessages({ connectionId: 'saved', includeSensitive: true });
  assert.deepEqual(page.messages.map((message) => message.sequence), [2, 3]);
  assert.equal(page.dropped_message_count, 1); assert.equal(restored.getConnection({ connectionId: 'saved' }).next_message_sequence, 4);
  const plan = buildWebSocketReplayPlan(restored.exportTranscript({ connectionId: 'saved' }), { mutations: [{ sequence: 2, text: 'changed' }, { sequence: 3, drop: true }] });
  assert.equal(plan.live_injection_supported, false); assert.deepEqual(plan.frames.map((frame) => frame.data.text), ['changed']);
});

test('JSONL backend restores snapshots through private atomic files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'proxy-mate-ws-'));
  const backend = new JsonlWebSocketStoreBackend(join(directory, 'sockets.jsonl'));
  const store = new WebSocketStore({ backend }); store.onRequest({ id: 'disk', url: 'wss://disk.test' }); store.onMessageReceived({ id: 'disk', data: 'persisted' }); await store.flush();
  assert.equal((await stat(join(directory, 'sockets.jsonl'))).mode & 0o777, 0o600);
  const restored = new WebSocketStore({ backend }); await restored.restore();
  assert.equal(restored.listMessages({ connectionId: 'disk', includeSensitive: true }).messages[0].data.text, 'persisted');
});

test('JSONL appends deltas, compacts bounded history, and reloads legacy snapshots', async () => {
  const { readFile, writeFile } = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'proxy-mate-ws-append-'));
  const file = join(directory, 'frames.jsonl');
  const store = new WebSocketStore({ backend: new JsonlWebSocketStoreBackend(file), maxMessagesPerConnection: 3 });
  store.onRequest({ id: 'append', url: 'wss://append.test' });
  await store.flush();
  const prefix = await readFile(file, 'utf8');
  store.onMessageReceived({ id: 'append', data: 'first' });
  await store.flush();
  assert.ok((await readFile(file, 'utf8')).startsWith(prefix));
  for (let i = 0; i < 80; i++) {
    store.onMessageSent({ id: 'append', data: `frame-${i}` });
    await store.flush();
  }
  const restored = new WebSocketStore({ backend: new JsonlWebSocketStoreBackend(file), maxMessagesPerConnection: 3 });
  await restored.restore(); await restored.flush();
  assert.deepEqual(restored.exportTranscript({ connectionId: 'append' }).connection, store.exportTranscript({ connectionId: 'append' }).connection);
  assert.ok((await stat(file)).size < 20_000);
  await writeFile(file, JSON.stringify(store.exportSnapshot()) + '\n');
  const legacy = new WebSocketStore({ backend: new JsonlWebSocketStoreBackend(file) });
  await legacy.restore(); await legacy.flush();
  assert.equal(legacy.listMessages({ connectionId: 'append' }).messages.length, 3);
});

test('journal preserves eviction across connections and reused connection ids', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'proxy-mate-ws-eviction-'));
  const backend = new JsonlWebSocketStoreBackend(join(directory, 'frames.jsonl'));
  const store = new WebSocketStore({ backend, maxConnections: 2, maxTotalMessageBytes: 600 });
  store.onRequest({ id: 'a' }); store.onMessageSent({ id: 'a', data: 'old' }); await store.flush();
  store.onRequest({ id: 'b' }); store.onMessageSent({ id: 'b', data: 'b'.repeat(100) }); await store.flush();
  store.onRequest({ id: 'c' }); store.onMessageSent({ id: 'c', data: 'c'.repeat(100) });
  store.onRequest({ id: 'a' }); store.onMessageSent({ id: 'a', data: 'reused' }); await store.flush();
  const restored = new WebSocketStore({ backend: new JsonlWebSocketStoreBackend(backend.path), maxConnections: 2, maxTotalMessageBytes: 600 });
  await restored.restore(); await restored.flush();
  assert.deepEqual(restored.exportSnapshot().connections, store.exportSnapshot().connections);
});

test('save-only JSON backends retain coalescing and surface persistence errors', async () => {
  let snapshot, saves = 0;
  const store = new WebSocketStore({ backend: { save: async value => { snapshot = value; saves++; } } });
  store.onRequest({ id: 'json' });
  for (let i = 0; i < 10; i++) store.onMessageSent({ id: 'json', data: String(i) });
  await store.flush();
  assert.equal(saves, 1);
  assert.equal(snapshot.connections[0].messages.length, 10);
  store.backend.save = async () => { throw new Error('disk failed'); };
  store.onClose({ id: 'json' });
  await assert.rejects(store.flush(), /disk failed/);
  store.backend.save = async value => { snapshot = value; };
  store.onRequest({ id: 'recovered' }); await store.flush();
  assert.equal(snapshot.connections.length, 2);
});

test('journal recovers a torn final append and remains writable', async () => {
  const { appendFile } = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'proxy-mate-ws-torn-'));
  const file = join(directory, 'frames.jsonl');
  const store = new WebSocketStore({ backend: new JsonlWebSocketStoreBackend(file) });
  store.onRequest({ id: 'torn' }); store.onMessageSent({ id: 'torn', data: 'committed' }); await store.flush();
  await appendFile(file, '{"op":"batch","records":[');
  const restored = new WebSocketStore({ backend: new JsonlWebSocketStoreBackend(file) });
  await restored.restore(); await restored.flush();
  restored.onMessageSent({ id: 'torn', data: 'after recovery' }); await restored.flush();
  const again = new WebSocketStore({ backend: new JsonlWebSocketStoreBackend(file) });
  await again.restore(); await again.flush();
  assert.deepEqual(again.listMessages({ connectionId: 'torn', includeSensitive: true }).messages.map(m => m.data.text), ['committed', 'after recovery']);
});
