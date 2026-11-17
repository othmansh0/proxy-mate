// Bounded, in-memory WebSocket capture storage. This module deliberately has
// no Mockttp dependency: it accepts the event-shaped objects Mockttp emits, but
// can also be used by another proxy implementation or a future durable store.

import crypto from 'node:crypto';
import { appendFile, mkdir, readFile, rename, truncate, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const DEFAULT_MAX_CONNECTIONS = 500;
const DEFAULT_MAX_MESSAGES = 1_000;
const DEFAULT_MAX_MESSAGE_BYTES = 256 * 1024;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1_000;
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i;
const SENSITIVE_QUERY = /^(access_token|api[_-]?key|auth|authorization|password|secret|session|token)$/i;
const SENSITIVE_FIELD = /(?:^|[_-])(access[_-]?token|api[_-]?key|auth(?:orization)?|password|secret|session|token)(?:$|[_-])/i;

export class WebSocketStoreError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'WebSocketStoreError';
    this.code = code;
    this.details = details;
  }
}

/**
 * A connection store with independent, monotonically increasing message
 * sequences. Sequences are not reused when a ring evicts messages, which makes
 * forward cursor reads safe for an MCP client that polls while a socket is live.
 */
export class WebSocketStore {
  constructor({
    maxConnections = DEFAULT_MAX_CONNECTIONS,
    maxMessagesPerConnection = DEFAULT_MAX_MESSAGES,
    maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
    maxTotalMessageBytes = 16 * 1024 * 1024,
    clock = () => Date.now(),
    backend = null,
  } = {}) {
    this.maxConnections = positiveInteger(maxConnections, 'maxConnections');
    this.maxMessagesPerConnection = positiveInteger(maxMessagesPerConnection, 'maxMessagesPerConnection');
    this.maxMessageBytes = positiveInteger(maxMessageBytes, 'maxMessageBytes');
    this.maxTotalMessageBytes = positiveInteger(maxTotalMessageBytes, 'maxTotalMessageBytes');
    this.retainedMessageBytes = 0;
    this.clock = clock;
    this.connections = new Map();
    this.connectionOrder = [];
    this.backend = backend;
    this.persistence = Promise.resolve();
    this.persistenceScheduled = false;
    this.persistenceDirty = false;
    this.persistenceError = null;
    this.dirtyConnections = new Set();
    this.resetConnections = new Set();
    this.persistedSequences = new Map();
    this.resetPersistence = false;
  }

  // Mockttp event adapter methods. They intentionally accept the source event
  // unchanged, including the normal { id, ... } convention used by request,
  // accepted, message-received, message-sent, close, and error callbacks.
  onRequest(event = {}) {
    const connection = this.#ensure(event);
    connection.request = normalizeRequest(event, this.clock);
    connection.updated_at = nowIso(this.clock);
    this.#persist(connection);
    return publicConnection(connection);
  }

  onAccepted(event = {}) {
    const connection = this.#ensure(event);
    connection.accepted = normalizeAccepted(event, this.clock);
    connection.state = 'open';
    connection.opened_at ??= connection.accepted.timestamp;
    connection.updated_at = nowIso(this.clock);
    this.#persist(connection);
    return publicConnection(connection);
  }

  onMessageReceived(event = {}) { return this.#appendMessage(event, 'received'); }
  onMessageSent(event = {}) { return this.#appendMessage(event, 'sent'); }

  onClose(event = {}) {
    const connection = this.#ensure(event);
    const timestamp = eventTimestamp(event, this.clock);
    connection.close = {
      timestamp,
      code: finiteInteger(event.code ?? event.closeCode ?? event.statusCode),
      reason: stringOrNull(event.reason ?? event.closeReason),
      was_clean: booleanOrNull(event.wasClean ?? event.was_clean),
    };
    connection.state = 'closed';
    connection.closed_at = timestamp;
    connection.updated_at = timestamp;
    this.#persist(connection);
    return publicConnection(connection);
  }

  onError(event = {}) {
    const connection = this.#ensure(event);
    const error = event.error ?? event;
    const timestamp = eventTimestamp(event, this.clock);
    connection.error = {
      timestamp,
      code: stringOrNull(error?.code ?? event.errorCode),
      message: stringOrNull(error?.message ?? event.message),
    };
    // A later close is allowed to supersede this state while retaining error
    // detail, as most transport failures produce both events.
    if (connection.state !== 'closed') connection.state = 'error';
    connection.updated_at = timestamp;
    this.#persist(connection);
    return publicConnection(connection);
  }

  getConnection({ connectionId, includeSensitive = false } = {}) {
    const connection = this.connections.get(normalizeConnectionId(connectionId));
    return connection ? publicConnection(connection, includeSensitive) : null;
  }

  listConnections({ state, url_contains, limit = DEFAULT_PAGE_SIZE, includeSensitive = false } = {}) {
    const needle = stringOrNull(url_contains)?.toLowerCase();
    const items = this.connectionOrder
      .map((id) => this.connections.get(id))
      .filter(Boolean)
      .filter((connection) => !state || connection.state === state)
      .filter((connection) => !needle || (connection.request?.url ?? '').toLowerCase().includes(needle))
      .slice(-normalizeLimit(limit))
      .reverse()
      .map((connection) => publicConnection(connection, includeSensitive));
    return { connections: items, total: this.connections.size };
  }

  listMessages({
    connectionId,
    cursor = null,
    limit = DEFAULT_PAGE_SIZE,
    direction = null,
    contains = null,
    includeSensitive = false,
  } = {}) {
    const id = normalizeConnectionId(connectionId);
    const connection = this.connections.get(id);
    if (!connection) throw new WebSocketStoreError('WEBSOCKET_NOT_FOUND', `WebSocket connection was not found: ${id}`);
    if (direction != null && direction !== 'sent' && direction !== 'received') {
      throw new WebSocketStoreError('INVALID_DIRECTION', 'direction must be "sent" or "received"');
    }
    const after = cursor ? decodeCursor(cursor, id) : 0;
    const needle = stringOrNull(contains)?.toLowerCase();
    const all = connection.messages
      .filter((message) => message.sequence > after)
      .filter((message) => !direction || message.direction === direction)
      .filter((message) => !needle || messageSearchText(message).toLowerCase().includes(needle));
    const messages = all.slice(0, normalizeLimit(limit));
    const hasMore = all.length > messages.length;
    const last = messages.at(-1)?.sequence ?? after;
    const firstAvailable = connection.messages[0]?.sequence ?? connection.next_message_sequence;
    return {
      connection: publicConnection(connection, includeSensitive),
      messages: messages.map((message) => publicMessage(message, includeSensitive)),
      has_more: hasMore,
      next_cursor: hasMore ? encodeCursor(id, last) : null,
      snapshot_id: `${id}:${connection.next_message_sequence - 1}`,
      first_available_sequence: firstAvailable,
      // Cursor zero is also expired when sequence one has been evicted: it
      // signifies that a client asking from the beginning cannot see history.
      cursor_expired: after < firstAvailable - 1,
      dropped_message_count: connection.dropped_message_count,
    };
  }

  clear() {
    const cleared = this.connections.size;
    this.connections.clear();
    this.connectionOrder.length = 0;
    this.retainedMessageBytes = 0;
    this.#persist();
    return { cleared };
  }

  /** A portable, JSON-serializable snapshot. It retains ring cursors exactly. */
  exportSnapshot({ includeSensitive = true } = {}) {
    return {
      format: 'proxy-mate.websocket-store/v1', exported_at: nowIso(this.clock),
      connections: this.connectionOrder.map((id) => this.connections.get(id)).filter(Boolean).map((connection) => serializeConnection(connection, includeSensitive)),
    };
  }

  importSnapshot(snapshot, { replace = true } = {}) {
    if (!snapshot || !['proxy-mate.websocket-store/v1', 'proxy-mcp.websocket-store/v1'].includes(snapshot.format) || !Array.isArray(snapshot.connections)) {
      throw new WebSocketStoreError('INVALID_SNAPSHOT', 'snapshot must be a proxy-mate.websocket-store/v1 export');
    }
    if (replace) { this.connections.clear(); this.connectionOrder.length = 0; }
    for (const raw of snapshot.connections) this.#importConnection(raw);
    this.#enforceConnectionRetention();
    this.#recountAndLimitBytes();
    this.#persist();
    return { imported: snapshot.connections.length, total: this.connections.size };
  }

  exportTranscript({ connectionId, includeSensitive = true } = {}) {
    const connection = this.connections.get(normalizeConnectionId(connectionId));
    if (!connection) throw new WebSocketStoreError('WEBSOCKET_NOT_FOUND', `WebSocket connection was not found: ${connectionId}`);
    return { format: 'proxy-mate.websocket-transcript/v1', exported_at: nowIso(this.clock), connection: serializeConnection(connection, includeSensitive) };
  }

  importTranscript(transcript, { replace = false } = {}) {
    if (!transcript || !['proxy-mate.websocket-transcript/v1', 'proxy-mcp.websocket-transcript/v1'].includes(transcript.format) || !transcript.connection) throw new WebSocketStoreError('INVALID_TRANSCRIPT', 'transcript must be a proxy-mate.websocket-transcript/v1 export');
    if (replace) this.connections.delete(normalizeConnectionId(transcript.connection.id));
    this.#importConnection(transcript.connection);
    this.#enforceConnectionRetention(); this.#recountAndLimitBytes(); this.#persist();
    return this.getConnection({ connectionId: transcript.connection.id, includeSensitive: true });
  }

  async restore() {
    if (!this.backend?.load) return { restored: 0, supported: false };
    const snapshot = await this.backend.load();
    if (!snapshot) return { restored: 0, supported: true };
    return { ...this.importSnapshot(snapshot), restored: snapshot.connections.length, supported: true };
  }

  async flush() {
    do { await this.persistence; } while (this.persistenceScheduled);
    if (this.persistenceError) throw this.persistenceError;
  }

  #appendMessage(event, direction) {
    const connection = this.#ensure(event);
    const timestamp = eventTimestamp(event, this.clock);
    const message = normalizeMessage({ event, direction, sequence: connection.next_message_sequence, timestamp, maxBytes: this.maxMessageBytes });
    connection.next_message_sequence += 1;
    connection.messages.push(message);
    this.retainedMessageBytes += messageStorageBytes(message);
    while (connection.messages.length > this.maxMessagesPerConnection) {
      this.retainedMessageBytes -= messageStorageBytes(connection.messages.shift());
      connection.dropped_message_count += 1;
    }
    if (connection.state === 'opening') {
      connection.state = 'open';
      connection.opened_at ??= timestamp;
    }
    connection.updated_at = timestamp;
    this.#limitBytes();
    this.#persist(connection);
    return publicMessage(message);
  }

  #ensure(event) {
    const id = eventConnectionId(event);
    let connection = this.connections.get(id);
    if (connection) return connection;
    const timestamp = eventTimestamp(event, this.clock);
    connection = {
      id,
      state: 'opening',
      created_at: timestamp,
      updated_at: timestamp,
      opened_at: null,
      closed_at: null,
      request: null,
      accepted: null,
      close: null,
      error: null,
      next_message_sequence: 1,
      dropped_message_count: 0,
      messages: [],
    };
    this.connections.set(id, connection);
    if (this.backend?.save) this.resetConnections.add(id);
    this.connectionOrder.push(id);
    while (this.connectionOrder.length > this.maxConnections) {
      const staleId = this.connectionOrder.shift();
      for (const message of this.connections.get(staleId)?.messages ?? []) this.retainedMessageBytes -= messageStorageBytes(message);
      this.connections.delete(staleId);
      if (this.backend?.save) this.dirtyConnections.add(staleId);
    }
    return connection;
  }

  #importConnection(raw) {
    const id = normalizeConnectionId(raw?.id);
    const messages = Array.isArray(raw.messages) ? raw.messages.map(deserializeMessage).filter(Boolean).sort((a, b) => a.sequence - b.sequence) : [];
    const maxSequence = messages.at(-1)?.sequence ?? 0;
    const connection = {
      id, state: ['opening', 'open', 'closed', 'error'].includes(raw.state) ? raw.state : 'opening',
      created_at: validIso(raw.created_at) ?? nowIso(this.clock), updated_at: validIso(raw.updated_at) ?? nowIso(this.clock),
      opened_at: validIso(raw.opened_at), closed_at: validIso(raw.closed_at), request: raw.request ? normalizeStoredRequest(raw.request) : null,
      accepted: raw.accepted ? normalizeStoredAccepted(raw.accepted) : null, close: raw.close ?? null, error: raw.error ?? null,
      next_message_sequence: Math.max(maxSequence + 1, Number.isInteger(raw.next_message_sequence) ? raw.next_message_sequence : 1),
      dropped_message_count: Math.max(0, Number(raw.dropped_message_count) || 0), messages: messages.slice(-this.maxMessagesPerConnection),
    };
    connection.dropped_message_count += Math.max(0, messages.length - connection.messages.length);
    if (this.connections.has(id)) this.connectionOrder = this.connectionOrder.filter((item) => item !== id);
    this.connections.set(id, connection); this.connectionOrder.push(id);
  }

  #enforceConnectionRetention() { while (this.connectionOrder.length > this.maxConnections) this.connections.delete(this.connectionOrder.shift()); }
  #recountAndLimitBytes() {
    this.retainedMessageBytes = 0;
    for (const connection of this.connections.values()) {
      for (const message of connection.messages) this.retainedMessageBytes += messageStorageBytes(message);
    }
    this.#limitBytes();
  }

  #limitBytes() {
    // Bound the whole store, not just each connection independently. Include
    // string expansion and metadata so tiny frames are bounded as well.
    for (const id of this.connectionOrder) {
      if (this.retainedMessageBytes <= this.maxTotalMessageBytes) break;
      const connection = this.connections.get(id);
      while (connection?.messages.length && this.retainedMessageBytes > this.maxTotalMessageBytes) {
        this.retainedMessageBytes -= messageStorageBytes(connection.messages.shift());
        connection.dropped_message_count += 1;
        if (this.backend?.save) this.dirtyConnections.add(id);
      }
    }
  }
  #persist(connection = null) {
    if (!this.backend?.save) return;
    if (connection) this.dirtyConnections.add(connection.id);
    else this.resetPersistence = true;
    this.persistenceDirty = true;
    if (this.persistenceScheduled) return;
    this.persistenceScheduled = true;
    this.persistence = new Promise(resolve => setImmediate(resolve)).then(async () => {
      while (this.persistenceDirty) {
        this.persistenceDirty = false;
        const reset = this.resetPersistence;
        this.resetPersistence = false;
        const ids = reset ? this.connectionOrder.slice() : [
          ...[...this.dirtyConnections].filter(id => !this.connections.has(id)),
          ...this.connectionOrder.filter(id => this.dirtyConnections.has(id)),
        ];
        this.dirtyConnections.clear();
        const records = reset ? [{ op: 'reset' }] : [];
        const sequences = new Map();
        for (const id of ids) {
          const current = this.connections.get(id);
          if (!current) { records.push({ op: 'delete', id }); sequences.set(id, null); continue; }
          const fresh = reset || this.resetConnections.has(id);
          if (fresh && !reset) records.push({ op: 'delete', id });
          const after = fresh ? 0 : (this.persistedSequences.get(id) ?? 0);
          const { messages, ...metadata } = current;
          records.push({ op: 'upsert', connection: structuredClone(metadata),
            first_sequence: messages[0]?.sequence ?? current.next_message_sequence,
            messages: messages.filter(message => message.sequence > after).map(message => publicMessage(message, true)) });
          sequences.set(id, current.next_message_sequence - 1);
        }
        this.resetConnections.clear();
        try {
          if (this.backend.append) await this.backend.append(records);
          else await this.backend.save(this.exportSnapshot({ includeSensitive: true }));
          if (reset) this.persistedSequences.clear();
          for (const [id, sequence] of sequences) {
            if (sequence === null) this.persistedSequences.delete(id);
            else this.persistedSequences.set(id, sequence);
          }
          this.persistenceError = null;
        } catch (error) {
          // A later event retries a full snapshot; a failed append may have
          // reached disk, so deltas alone cannot safely infer its boundary.
          this.resetPersistence = true;
          throw error;
        }
        if (this.persistenceDirty) await new Promise(resolve => setImmediate(resolve));
      }
    }).catch(error => { this.persistenceError = error; }).finally(() => {
      this.persistenceScheduled = false;
      if (this.persistenceDirty && !this.persistenceError) this.#persist();
    });
  }
}

function messageStorageBytes(message) {
  return 256 + 2 * ((message.data.text?.length ?? 0) + (message.data.base64?.length ?? 0));
}

/** Append-only private JSONL journal. Legacy snapshot lines remain readable.
 * Compaction rewrites at most the bounded live store, yielding every 64 rows.
 */
export class JsonlWebSocketStoreBackend {
  constructor(path) {
    if (!path || typeof path !== 'string') throw new WebSocketStoreError('INVALID_CONFIGURATION', 'JSONL backend path is required');
    this.path = path;
    this.live = new Map();
    this.bytes = 0;
    this.liveBytes = 0;
    this.sizes = new Map();
    this.metadataSizes = new Map();
    this.messageSizes = new WeakMap();
    this.loaded = false;
    this.tornTail = false;
  }

  #apply(record) {
    if (record.op === 'batch') {
      for (const item of record.records) this.#apply(item);
    } else if (record.connections) {
      this.live.clear(); this.sizes.clear(); this.metadataSizes.clear(); this.liveBytes = 0;
      for (const connection of record.connections) this.#apply({ op: 'upsert', connection, first_sequence: 0, messages: connection.messages ?? [] });
    } else if (record.op === 'reset') {
      this.live.clear(); this.sizes.clear(); this.metadataSizes.clear(); this.liveBytes = 0;
    } else if (record.op === 'delete') {
      this.live.delete(record.id);
      this.liveBytes -= this.sizes.get(record.id) ?? 0;
      this.sizes.delete(record.id);
      this.metadataSizes.delete(record.id);
    } else if (record.op === 'upsert') {
      const id = record.connection.id;
      const previous = this.live.get(id);
      const oldMessages = previous?.messages ?? [];
      const messages = [];
      let removedBytes = 0;
      for (const message of oldMessages) {
        if (message.sequence >= record.first_sequence) messages.push(message);
        else removedBytes += this.messageSizes.get(message) ?? 0;
      }
      const after = messages.at(-1)?.sequence ?? 0;
      let addedBytes = 0;
      for (const message of record.messages) {
        if (message.sequence <= after) continue;
        const size = Buffer.byteLength(JSON.stringify(message)) + 1;
        this.messageSizes.set(message, size);
        addedBytes += size;
        messages.push(message);
      }
      const { messages: ignored, ...metadata } = record.connection;
      const metadataSize = Buffer.byteLength(JSON.stringify(metadata)) + 16;
      const size = (this.sizes.get(id) ?? 0) - (this.metadataSizes.get(id) ?? 0)
        + metadataSize - removedBytes + addedBytes;
      this.live.set(id, { ...metadata, messages });
      this.liveBytes += size - (this.sizes.get(id) ?? 0);
      this.metadataSizes.set(id, metadataSize);
      this.sizes.set(id, size);
    } else throw new Error('Unknown WebSocket journal record');
  }

  async load() {
    try {
      const text = await readFile(this.path, 'utf8');
      this.live.clear(); this.sizes.clear(); this.metadataSizes.clear(); this.liveBytes = 0;
      const lines = text.split('\n');
      let validText = text;
      this.tornTail = false;
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (!line.trim()) continue;
        let record;
        try { record = JSON.parse(line); }
        catch (error) {
          // An interrupted append has no newline. Corruption in any complete
          // record is still reported; only the incomplete final batch is lost.
          if (index !== lines.length - 1 || text.endsWith('\n')) throw error;
          validText = text.slice(0, text.lastIndexOf('\n') + 1);
          this.tornTail = true;
          break;
        }
        this.#apply(record);
      }
      this.needsNewline = validText.length > 0 && !validText.endsWith('\n');
      this.bytes = Buffer.byteLength(validText);
      this.loaded = true;
      return { format: 'proxy-mate.websocket-store/v1', connections: [...this.live.values()] };
    } catch (error) {
      if (error?.code === 'ENOENT') { this.loaded = true; return null; }
      throw new WebSocketStoreError('WEBSOCKET_PERSISTENCE_READ_FAILED', error.message);
    }
  }

  async append(records) {
    try {
      if (!this.loaded) await this.load();
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      if (this.tornTail) { await truncate(this.path, this.bytes); this.tornTail = false; }
      const text = (this.needsNewline ? '\n' : '') + JSON.stringify({ op: 'batch', records }) + '\n';
      this.needsNewline = false;
      await appendFile(this.path, text, { mode: 0o600 });
      this.bytes += Buffer.byteLength(text);
      for (const record of records) this.#apply(record);
      // The small floor avoids compacting on every tiny metadata update.
      if (this.bytes > Math.max(4096, 2 * this.liveBytes)) await this.#compact();
    } catch (error) {
      this.loaded = false;
      throw new WebSocketStoreError('WEBSOCKET_PERSISTENCE_WRITE_FAILED', error.message);
    }
  }

  async save(snapshot) {
    await this.append([{ op: 'reset' }, ...snapshot.connections.map(connection => ({
      op: 'upsert', connection, first_sequence: 0, messages: connection.messages ?? [],
    }))]);
  }

  async #compact() {
    const temporary = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ op: 'reset' }) + '\n', { mode: 0o600, flag: 'wx' });
      let chunk = [], bytes = Buffer.byteLength(JSON.stringify({ op: 'reset' }) + '\n');
      for (const connection of this.live.values()) {
        chunk.push(JSON.stringify({ op: 'upsert', connection: { ...connection, messages: undefined }, first_sequence: 0, messages: connection.messages }) + '\n');
        if (chunk.length === 64) {
          const text = chunk.join(''); bytes += Buffer.byteLength(text);
          await appendFile(temporary, text); chunk = [];
          await new Promise(resolve => setImmediate(resolve));
        }
      }
      const text = chunk.join(''); bytes += Buffer.byteLength(text);
      await appendFile(temporary, text);
      await rename(temporary, this.path);
      this.bytes = bytes;
    } catch (error) { try { await unlink(temporary); } catch { /* preserve original error */ } throw error; }
  }
}

/** Produce replay data only; this proxy intentionally cannot inject frames into a live socket. */
export function buildWebSocketReplayPlan(transcript, { mutations = [] } = {}) {
  if (!transcript || !['proxy-mate.websocket-transcript/v1', 'proxy-mcp.websocket-transcript/v1'].includes(transcript.format)) throw new WebSocketStoreError('INVALID_TRANSCRIPT', 'transcript must be a proxy-mate.websocket-transcript/v1 export');
  const connection = structuredClone(transcript.connection);
  for (const mutation of mutations) applyFrameMutation(connection.messages, mutation);
  return { format: 'proxy-mate.websocket-replay-plan/v1', live_injection_supported: false, reason: 'Captured WebSocket frames are export/replay data; live frame injection is not supported.', connection_id: connection.id, frames: connection.messages.map((message) => ({ sequence: message.sequence, direction: message.direction, timestamp: message.timestamp, data: message.data })) };
}

function applyFrameMutation(messages, mutation = {}) {
  const message = messages.find((candidate) => candidate.sequence === mutation.sequence);
  if (!message) throw new WebSocketStoreError('FRAME_NOT_FOUND', `No transcript frame has sequence ${mutation.sequence}`);
  if (mutation.drop === true) { messages.splice(messages.indexOf(message), 1); return; }
  if (typeof mutation.text === 'string') { message.data = storedTextData(mutation.text); return; }
  if (typeof mutation.base64 === 'string') { const value = Buffer.from(mutation.base64, 'base64'); message.data = storedBinaryData(value); return; }
  throw new WebSocketStoreError('INVALID_FRAME_MUTATION', 'frame mutation must set drop, text, or base64');
}

// Directly usable with Mockttp: for (const [name, handler] of
// Object.entries(mockttpWebSocketHandlers(store))) await server.on(name, handler).
// Mockttp has no websocket-error event; callers can attach `onError` to an
// appropriate transport diagnostic source if it can be correlated to streamId.
export function mockttpWebSocketHandlers(store) {
  if (!(store instanceof WebSocketStore)) throw new TypeError('store must be a WebSocketStore');
  return {
    'websocket-request': (event) => store.onRequest(event),
    'websocket-accepted': (event) => store.onAccepted(event),
    'websocket-message-received': (event) => store.onMessageReceived(event),
    'websocket-message-sent': (event) => store.onMessageSent(event),
    'websocket-close': (event) => store.onClose(event),
  };
}

export function redactWebSocketHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers ?? {}).map(([name, value]) => [name, SENSITIVE_HEADER.test(name) ? '[REDACTED]' : value]));
}

export function redactWebSocketUrl(value) {
  if (!value) return value ?? null;
  try {
    const url = new URL(value);
    for (const [key] of url.searchParams) if (SENSITIVE_QUERY.test(key)) url.searchParams.set(key, '[REDACTED]');
    return url.toString();
  } catch { return value; }
}

export function redactWebSocketText(value) {
  const text = String(value ?? '');
  try {
    const parsed = JSON.parse(text);
    return JSON.stringify(redactJson(parsed));
  } catch {
    return text
      .replace(/((?:access[_-]?token|api[_-]?key|authorization|password|secret|session|token)\s*[=:]\s*)([^\s,;&]+)/gi, '$1[REDACTED]')
      .replace(/(Bearer\s+)[^\s,;&]+/gi, '$1[REDACTED]');
  }
}

function redactJson(value) {
  if (Array.isArray(value)) return value.map(redactJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, SENSITIVE_FIELD.test(key) ? '[REDACTED]' : redactJson(child)]));
}

function normalizeRequest(event, clock) {
  const request = event.request ?? event;
  return {
    timestamp: eventTimestamp(event, clock),
    method: stringOrNull(request.method) ?? 'GET',
    url: stringOrNull(request.url ?? request.uri),
    protocol: stringOrNull(request.protocol),
    headers: cloneHeaders(request.headers),
  };
}

function normalizeAccepted(event, clock) {
  const accepted = event.response ?? event.accepted ?? event;
  return {
    timestamp: eventTimestamp(event, clock),
    status_code: finiteInteger(accepted.statusCode ?? accepted.status_code),
    headers: cloneHeaders(accepted.headers),
    protocol: stringOrNull(accepted.protocol),
  };
}

function normalizeMessage({ event, direction, sequence, timestamp, maxBytes }) {
  const payload = extractPayload(event);
  const isText = typeof payload === 'string' || event.isBinary === false || event.type === 'text';
  const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? '', isText ? 'utf8' : undefined);
  const stored = buffer.subarray(0, maxBytes);
  const truncated = buffer.length > stored.length;
  const data = {
    type: isText ? 'text' : 'binary',
    byte_size: buffer.length,
    stored_byte_size: stored.length,
    truncated,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  };
  if (isText) data.text = stored.toString('utf8');
  else data.base64 = stored.toString('base64');
  return { id: `message_${sequence}`, sequence, direction, timestamp, data };
}

function serializeConnection(connection, includeSensitive) {
  const publicValue = publicConnection(connection, includeSensitive);
  return { ...publicValue, messages: connection.messages.map((message) => publicMessage(message, includeSensitive)) };
}
function deserializeMessage(raw) {
  if (!raw || !Number.isInteger(raw.sequence) || raw.sequence < 1 || !['sent', 'received'].includes(raw.direction) || !raw.data) return null;
  const data = raw.data;
  if (data.type === 'text' && typeof data.text !== 'string') return null;
  if (data.type === 'binary' && typeof data.base64 !== 'string') return null;
  const payload = data.type === 'text' ? Buffer.from(data.text, 'utf8') : Buffer.from(data.base64, 'base64');
  return {
    id: `message_${raw.sequence}`, sequence: raw.sequence, direction: raw.direction,
    timestamp: validIso(raw.timestamp) ?? new Date(0).toISOString(),
    data: { type: data.type, byte_size: Number.isFinite(data.byte_size) ? data.byte_size : payload.length, stored_byte_size: payload.length, truncated: Boolean(data.truncated), sha256: typeof data.sha256 === 'string' ? data.sha256 : crypto.createHash('sha256').update(payload).digest('hex'), ...(data.type === 'text' ? { text: data.text } : { base64: data.base64 }) },
  };
}
function normalizeStoredRequest(value) { return { timestamp: validIso(value.timestamp) ?? new Date(0).toISOString(), method: stringOrNull(value.method) ?? 'GET', url: stringOrNull(value.url), protocol: stringOrNull(value.protocol), headers: cloneHeaders(value.headers) }; }
function normalizeStoredAccepted(value) { return { timestamp: validIso(value.timestamp) ?? new Date(0).toISOString(), status_code: finiteInteger(value.status_code), headers: cloneHeaders(value.headers), protocol: stringOrNull(value.protocol) }; }
function validIso(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null; }
function storedTextData(text) { const buffer = Buffer.from(text); return { type: 'text', byte_size: buffer.length, stored_byte_size: buffer.length, truncated: false, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), text }; }
function storedBinaryData(buffer) { return { type: 'binary', byte_size: buffer.length, stored_byte_size: buffer.length, truncated: false, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), base64: buffer.toString('base64') }; }

function extractPayload(event) {
  const message = event.message ?? event;
  const candidate = message.data ?? message.content ?? message.body ?? message.payload;
  if (Buffer.isBuffer(candidate) || typeof candidate === 'string') return candidate;
  if (candidate instanceof Uint8Array) return Buffer.from(candidate);
  if (Buffer.isBuffer(event.body) || typeof event.body === 'string') return event.body;
  if (event.body instanceof Uint8Array) return Buffer.from(event.body);
  return '';
}

function publicConnection(connection, includeSensitive = false) {
  const request = connection.request && {
    ...connection.request,
    url: includeSensitive ? connection.request.url : redactWebSocketUrl(connection.request.url),
    headers: includeSensitive ? cloneHeaders(connection.request.headers) : redactWebSocketHeaders(connection.request.headers),
  };
  return {
    id: connection.id,
    state: connection.state,
    created_at: connection.created_at,
    updated_at: connection.updated_at,
    opened_at: connection.opened_at,
    closed_at: connection.closed_at,
    request,
    accepted: connection.accepted && { ...connection.accepted, headers: includeSensitive ? cloneHeaders(connection.accepted.headers) : redactWebSocketHeaders(connection.accepted.headers) },
    close: connection.close && { ...connection.close },
    error: connection.error && { ...connection.error },
    next_message_sequence: connection.next_message_sequence,
    retained_message_count: connection.messages.length,
    dropped_message_count: connection.dropped_message_count,
  };
}

function publicMessage(message, includeSensitive = false) {
  const data = { ...message.data };
  if (!includeSensitive && data.type === 'text') data.text = redactWebSocketText(data.text);
  if (!includeSensitive && data.type === 'binary') {
    delete data.base64;
    data.omitted = true;
    data.omission_reason = 'binary WebSocket payload requires include_sensitive=true and the server-level sensitive-data grant';
  }
  return { ...message, data };
}

function messageSearchText(message) {
  return message.data.type === 'text' ? message.data.text : Buffer.from(message.data.base64, 'base64').toString('base64');
}

function eventConnectionId(event) {
  // Mockttp exposes streamId on messages and close events. Requests and
  // accepted responses use their normal request id, which is the same stream
  // identifier for a WebSocket upgrade.
  const id = event.connectionId ?? event.connection_id ?? event.streamId ?? event.webSocketId ?? event.websocketId ?? event.id ?? event.requestId;
  return normalizeConnectionId(id);
}

function normalizeConnectionId(value) {
  const id = String(value ?? '').trim();
  if (!/^[a-zA-Z0-9._:-]{1,200}$/.test(id)) throw new WebSocketStoreError('INVALID_CONNECTION_ID', 'connection_id must be a non-empty stable identifier');
  return id;
}

function eventTimestamp(event, clock) {
  const timing = event.timingEvents;
  // Mockttp timestamps within a request are monotonic. Convert them through
  // the request's epoch start rather than serializing an incorrect 1970 date.
  const monotonic = event.eventTimestamp
    ?? (event.closeCode !== undefined ? timing?.wsClosedTimestamp : undefined)
    ?? (event.statusCode === 101 ? timing?.wsAcceptedTimestamp : undefined);
  if (Number.isFinite(monotonic) && Number.isFinite(timing?.startTime) && Number.isFinite(timing?.startTimestamp)) {
    return new Date(timing.startTime + (monotonic - timing.startTimestamp)).toISOString();
  }
  if (Number.isFinite(timing?.startTime)) return new Date(timing.startTime).toISOString();
  const source = event.timestamp ?? event.createdAt ?? event.created_at;
  if (typeof source === 'string' && Number.isFinite(Date.parse(source))) return new Date(source).toISOString();
  if (typeof source === 'number' && Number.isFinite(source)) return new Date(source).toISOString();
  return nowIso(clock);
}

function cloneHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return {};
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, Array.isArray(value) ? [...value] : String(value)]));
}

function encodeCursor(id, sequence) { return Buffer.from(JSON.stringify({ id, sequence })).toString('base64url'); }
function decodeCursor(cursor, id) {
  try {
    const decoded = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (decoded.id !== id || !Number.isInteger(decoded.sequence) || decoded.sequence < 0) throw new Error('invalid');
    return decoded.sequence;
  } catch { throw new WebSocketStoreError('INVALID_CURSOR', 'cursor is invalid for this WebSocket connection'); }
}
function positiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) throw new WebSocketStoreError('INVALID_CONFIGURATION', `${field} must be a positive integer`);
  return value;
}
function normalizeLimit(value) {
  if (!Number.isInteger(value) || value < 1) throw new WebSocketStoreError('INVALID_LIMIT', 'limit must be a positive integer');
  return Math.min(value, MAX_PAGE_SIZE);
}
function nowIso(clock) { return new Date(clock()).toISOString(); }
function stringOrNull(value) { return value == null ? null : String(value); }
function finiteInteger(value) { return Number.isInteger(value) ? value : null; }
function booleanOrNull(value) { return typeof value === 'boolean' ? value : null; }
