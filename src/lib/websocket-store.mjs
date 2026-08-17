// Bounded, in-memory WebSocket capture storage. This module deliberately has
// no Mockttp dependency: it accepts the event-shaped objects Mockttp emits, but
// can also be used by another proxy implementation or a future durable store.

import crypto from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
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
    clock = () => Date.now(),
    backend = null,
  } = {}) {
    this.maxConnections = positiveInteger(maxConnections, 'maxConnections');
    this.maxMessagesPerConnection = positiveInteger(maxMessagesPerConnection, 'maxMessagesPerConnection');
    this.maxMessageBytes = positiveInteger(maxMessageBytes, 'maxMessageBytes');
    this.clock = clock;
    this.connections = new Map();
    this.connectionOrder = [];
    this.backend = backend;
    this.persistence = Promise.resolve();
  }

  // Mockttp event adapter methods. They intentionally accept the source event
  // unchanged, including the normal { id, ... } convention used by request,
  // accepted, message-received, message-sent, close, and error callbacks.
  onRequest(event = {}) {
    const connection = this.#ensure(event);
    connection.request = normalizeRequest(event, this.clock);
    connection.updated_at = nowIso(this.clock);
    this.#persist();
    return publicConnection(connection);
  }

  onAccepted(event = {}) {
    const connection = this.#ensure(event);
    connection.accepted = normalizeAccepted(event, this.clock);
    connection.state = 'open';
    connection.opened_at ??= connection.accepted.timestamp;
    connection.updated_at = nowIso(this.clock);
    this.#persist();
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
    this.#persist();
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
    this.#persist();
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
    this.#persist();
    return { cleared };
  }

  /** A portable, JSON-serializable snapshot. It retains ring cursors exactly. */
  exportSnapshot({ includeSensitive = true } = {}) {
    return {
      format: 'proxy-mcp.websocket-store/v1', exported_at: nowIso(this.clock),
      connections: this.connectionOrder.map((id) => this.connections.get(id)).filter(Boolean).map((connection) => serializeConnection(connection, includeSensitive)),
    };
  }

  importSnapshot(snapshot, { replace = true } = {}) {
    if (!snapshot || snapshot.format !== 'proxy-mcp.websocket-store/v1' || !Array.isArray(snapshot.connections)) {
      throw new WebSocketStoreError('INVALID_SNAPSHOT', 'snapshot must be a proxy-mcp.websocket-store/v1 export');
    }
    if (replace) { this.connections.clear(); this.connectionOrder.length = 0; }
    for (const raw of snapshot.connections) this.#importConnection(raw);
    this.#enforceConnectionRetention();
    this.#persist();
    return { imported: snapshot.connections.length, total: this.connections.size };
  }

  exportTranscript({ connectionId, includeSensitive = true } = {}) {
    const connection = this.connections.get(normalizeConnectionId(connectionId));
    if (!connection) throw new WebSocketStoreError('WEBSOCKET_NOT_FOUND', `WebSocket connection was not found: ${connectionId}`);
    return { format: 'proxy-mcp.websocket-transcript/v1', exported_at: nowIso(this.clock), connection: serializeConnection(connection, includeSensitive) };
  }

  importTranscript(transcript, { replace = false } = {}) {
    if (!transcript || transcript.format !== 'proxy-mcp.websocket-transcript/v1' || !transcript.connection) throw new WebSocketStoreError('INVALID_TRANSCRIPT', 'transcript must be a proxy-mcp.websocket-transcript/v1 export');
    if (replace) this.connections.delete(normalizeConnectionId(transcript.connection.id));
    this.#importConnection(transcript.connection);
    this.#enforceConnectionRetention(); this.#persist();
    return this.getConnection({ connectionId: transcript.connection.id, includeSensitive: true });
  }

  async restore() {
    if (!this.backend?.load) return { restored: 0, supported: false };
    const snapshot = await this.backend.load();
    if (!snapshot) return { restored: 0, supported: true };
    return { ...this.importSnapshot(snapshot), restored: snapshot.connections.length, supported: true };
  }

  async flush() { await this.persistence; }

  #appendMessage(event, direction) {
    const connection = this.#ensure(event);
    const timestamp = eventTimestamp(event, this.clock);
    const message = normalizeMessage({ event, direction, sequence: connection.next_message_sequence, timestamp, maxBytes: this.maxMessageBytes });
    connection.next_message_sequence += 1;
    connection.messages.push(message);
    while (connection.messages.length > this.maxMessagesPerConnection) {
      connection.messages.shift();
      connection.dropped_message_count += 1;
    }
    if (connection.state === 'opening') {
      connection.state = 'open';
      connection.opened_at ??= timestamp;
    }
    connection.updated_at = timestamp;
    this.#persist();
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
    this.connectionOrder.push(id);
    while (this.connectionOrder.length > this.maxConnections) {
      const staleId = this.connectionOrder.shift();
      this.connections.delete(staleId);
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
  #persist() {
    if (!this.backend?.save) return;
    const snapshot = this.exportSnapshot({ includeSensitive: true });
    this.persistence = this.persistence.catch(() => undefined).then(() => this.backend.save(snapshot));
  }
}

/** Portable one-line JSON snapshot backend. Writes are private (0600) and atomic. */
export class JsonlWebSocketStoreBackend {
  constructor(path) { if (!path || typeof path !== 'string') throw new WebSocketStoreError('INVALID_CONFIGURATION', 'JSONL backend path is required'); this.path = path; }
  async load() {
    try { const text = await readFile(this.path, 'utf8'); const line = text.trim().split(/\r?\n/).at(-1); return line ? JSON.parse(line) : null; }
    catch (error) { if (error?.code === 'ENOENT') return null; throw new WebSocketStoreError('WEBSOCKET_PERSISTENCE_READ_FAILED', error.message); }
  }
  async save(snapshot) {
    const temporary = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try { await mkdir(dirname(this.path), { recursive: true, mode: 0o700 }); await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { mode: 0o600, flag: 'wx' }); await rename(temporary, this.path); }
    catch (error) { try { await unlink(temporary); } catch {} throw new WebSocketStoreError('WEBSOCKET_PERSISTENCE_WRITE_FAILED', error.message); }
  }
}

/** Produce replay data only; this proxy intentionally cannot inject frames into a live socket. */
export function buildWebSocketReplayPlan(transcript, { mutations = [] } = {}) {
  if (!transcript || transcript.format !== 'proxy-mcp.websocket-transcript/v1') throw new WebSocketStoreError('INVALID_TRANSCRIPT', 'transcript must be a proxy-mcp.websocket-transcript/v1 export');
  const connection = structuredClone(transcript.connection);
  for (const mutation of mutations) applyFrameMutation(connection.messages, mutation);
  return { format: 'proxy-mcp.websocket-replay-plan/v1', live_injection_supported: false, reason: 'Captured WebSocket frames are export/replay data; live frame injection is not supported.', connection_id: connection.id, frames: connection.messages.map((message) => ({ sequence: message.sequence, direction: message.direction, timestamp: message.timestamp, data: message.data })) };
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
