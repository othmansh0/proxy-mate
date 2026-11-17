import crypto from 'node:crypto';
import {
  redactBody as redactCapturedBody,
  redactHeaders as redactCapturedHeaders,
  redactUrl as redactCapturedUrl,
} from './redaction.mjs';

const DIRECTIONS = new Set(['request', 'response']);
const ACTIONS = new Set(['continue', 'modify', 'respond', 'abort', 'close', 'reset']);
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_PENDING = 100;
const DEFAULT_MAX_HISTORY = 500;
const DEFAULT_PREVIEW_BYTES = 16 * 1024;
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const METHOD = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32}$/;

export class BreakpointError extends Error {
  constructor(code, message, { retryable = false, details, recovery = [] } = {}) {
    super(message);
    this.name = 'BreakpointError';
    this.code = code;
    this.retryable = retryable;
    this.details = details;
    this.recovery = recovery;
  }
}

/**
 * Coordinates headless breakpoints without retaining raw intercepted messages.
 *
 * Mockttp integration:
 *   beforeRequest: (request) => manager.pause({ ruleId, direction: 'request', message: request })
 *   beforeResponse: (response, request) => manager.pause({
 *     ruleId, direction: 'response', message: { response, request }
 *   })
 *
 * `pause` resolves to exactly the value expected by each Mockttp callback:
 * request transforms (or `{ response: ... }`) for beforeRequest, and response
 * transforms (or `close`/`reset`) for beforeResponse.
 */
export class BreakpointManager {
  constructor({
    defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
    maxTimeoutMs = DEFAULT_MAX_TIMEOUT_MS,
    defaultAction = 'continue',
    maxPending = DEFAULT_MAX_PENDING,
    maxHistory = DEFAULT_MAX_HISTORY,
    maxPreviewBytes = DEFAULT_PREVIEW_BYTES,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
    allowSensitive = false,
    clock = () => Date.now(),
    idFactory,
  } = {}) {
    this.defaultTimeoutMs = positiveInteger(defaultTimeoutMs, 'defaultTimeoutMs');
    this.maxTimeoutMs = positiveInteger(maxTimeoutMs, 'maxTimeoutMs');
    if (this.defaultTimeoutMs > this.maxTimeoutMs) {
      throw invalidConfig('defaultTimeoutMs cannot exceed maxTimeoutMs.');
    }
    this.defaultAction = validateFallbackAction(defaultAction);
    this.maxPending = positiveInteger(maxPending, 'maxPending');
    this.maxHistory = nonNegativeInteger(maxHistory, 'maxHistory');
    this.maxPreviewBytes = positiveInteger(maxPreviewBytes, 'maxPreviewBytes');
    this.maxBodyBytes = positiveInteger(maxBodyBytes, 'maxBodyBytes');
    this.allowSensitive = allowSensitive === true;
    this.clock = clock;
    this.idFactory = idFactory;
    this.pending = new Map();
    this.history = [];
    this.sequence = 0;
    this.skippedOutOfScope = 0;
    this.closed = false;
  }

  pause({ ruleId, direction, message, timeoutMs, defaultAction, owner, scope = 'all', inScope = true } = {}) {
    validateRuleId(ruleId);
    if (!DIRECTIONS.has(direction)) {
      throw new BreakpointError('INVALID_BREAKPOINT_DIRECTION', 'direction must be either request or response.');
    }
    if (!message || typeof message !== 'object') {
      throw new BreakpointError('INVALID_BREAKPOINT_MESSAGE', 'message must be an intercepted Mockttp request or response object.');
    }

    const createdAt = this.clock();
    const id = this.#nextId(createdAt);
    const effectiveTimeout = timeoutMs === undefined
      ? this.defaultTimeoutMs
      : positiveInteger(timeoutMs, 'timeoutMs');
    if (effectiveTimeout > this.maxTimeoutMs) {
      throw new BreakpointError(
        'BREAKPOINT_TIMEOUT_TOO_LARGE',
        `timeoutMs cannot exceed ${this.maxTimeoutMs}.`,
        { details: { max_timeout_ms: this.maxTimeoutMs } },
      );
    }
    const fallback = defaultAction === undefined
      ? this.defaultAction
      : validateFallbackAction(defaultAction);
    const deadlineAt = createdAt + effectiveTimeout;
    const recordBase = {
      id,
      owner: owner ?? null,
      scope,
      rule_id: ruleId,
      direction,
      state: 'pending',
      created_at: toTimestamp(createdAt),
      deadline_at: toTimestamp(deadlineAt),
      timeout_ms: effectiveTimeout,
    };
    const publicRecord = Object.freeze({
      ...recordBase,
      redacted: true,
      message: snapshotMessage(direction, message, {
        allowSensitive: false,
        maxPreviewBytes: this.maxPreviewBytes,
      }),
    });
    const sensitiveRecord = this.allowSensitive ? Object.freeze({
      ...recordBase,
      redacted: false,
      message: snapshotMessage(direction, message, {
        allowSensitive: true,
        maxPreviewBytes: this.maxPreviewBytes,
      }),
    }) : null;

    if (scope === 'mine' && !inScope) {
      this.skippedOutOfScope++;
      this.#pushHistory(this.#historyRecord(publicRecord, {
        outcome: 'skipped_out_of_scope', action: 'continue', defaulted: true,
      }));
      return Promise.resolve(undefined);
    }

    if (this.closed || this.pending.size >= this.maxPending) {
      const outcome = this.closed ? 'manager_closed' : 'capacity_exceeded';
      const history = this.#historyRecord(publicRecord, {
        outcome,
        action: fallback,
        defaulted: true,
        reason: this.closed
          ? 'Breakpoint manager is closed.'
          : `Maximum pending breakpoint capacity (${this.maxPending}) was reached.`,
      });
      this.#pushHistory(history);
      return Promise.resolve(mapAction(direction, { action: fallback }, this.maxBodyBytes));
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#complete(id, {
          outcome: 'timed_out',
          action: fallback,
          defaulted: true,
          reason: `Breakpoint deadline elapsed after ${effectiveTimeout}ms.`,
        });
      }, effectiveTimeout);

      this.pending.set(id, {
        publicRecord,
        sensitiveRecord,
        resolve,
        timer,
        fallback,
      });
    });
  }

  listPending({ ruleId, direction, includeSensitive = false } = {}) {
    if (ruleId !== undefined) validateRuleId(ruleId);
    if (direction !== undefined && !DIRECTIONS.has(direction)) {
      throw new BreakpointError('INVALID_BREAKPOINT_DIRECTION', 'direction must be either request or response.');
    }
    const now = this.clock();
    this.#assertSensitiveRead(includeSensitive);
    return [...this.pending.values()]
      .map((entry) => includeSensitive ? entry.sensitiveRecord : entry.publicRecord)
      .filter((entry) => ruleId === undefined || entry.rule_id === ruleId)
      .filter((entry) => direction === undefined || entry.direction === direction)
      .map((entry) => clonePublic({ ...entry, remaining_ms: Math.max(0, Date.parse(entry.deadline_at) - now) }));
  }

  getPending(id, { includeSensitive = false } = {}) {
    const entry = this.pending.get(String(id));
    if (!entry) return null;
    this.#assertSensitiveRead(includeSensitive);
    const record = includeSensitive ? entry.sensitiveRecord : entry.publicRecord;
    return clonePublic({
      ...record,
      remaining_ms: Math.max(0, Date.parse(entry.publicRecord.deadline_at) - this.clock()),
    });
  }

  resolve(id, decision = { action: 'continue' }) {
    const key = String(id);
    const entry = this.pending.get(key);
    if (!entry) throw notFound(key);
    const normalized = validateDecision(entry.publicRecord.direction, decision, this.maxBodyBytes);
    return this.#complete(key, {
      outcome: 'resolved',
      action: normalized.action,
      decision: normalized,
      defaulted: false,
    });
  }

  cancel(id, { reason = 'Breakpoint was cancelled.', action } = {}) {
    const key = String(id);
    const entry = this.pending.get(key);
    if (!entry) throw notFound(key);
    const fallback = validateFallbackAction(action ?? entry.fallback);
    return this.#complete(key, {
      outcome: 'cancelled',
      action: fallback,
      defaulted: true,
      reason: safeReason(reason),
    });
  }

  closeAll({ reason = 'Breakpoint manager was stopped.', action } = {}) {
    const fallback = validateFallbackAction(action ?? this.defaultAction);
    const ids = [...this.pending.keys()];
    const outcomes = ids.map((id) => this.#complete(id, {
      outcome: 'closed',
      action: fallback,
      defaulted: true,
      reason: safeReason(reason),
    }));
    return { closed_count: outcomes.length, outcomes };
  }

  close(options = {}) {
    this.closed = true;
    return this.closeAll(options);
  }

  reopen() {
    this.closed = false;
  }

  getHistory({ limit, ruleId, direction, outcome } = {}) {
    const effectiveLimit = limit === undefined ? Math.min(100, this.maxHistory) : limit;
    if (!Number.isInteger(effectiveLimit) || effectiveLimit < 0 || effectiveLimit > this.maxHistory) {
      throw new BreakpointError('INVALID_BREAKPOINT_HISTORY_LIMIT', `limit must be between 0 and ${this.maxHistory}.`);
    }
    if (ruleId !== undefined) validateRuleId(ruleId);
    if (direction !== undefined && !DIRECTIONS.has(direction)) {
      throw new BreakpointError('INVALID_BREAKPOINT_DIRECTION', 'direction must be either request or response.');
    }
    return this.history
      .filter((entry) => ruleId === undefined || entry.rule_id === ruleId)
      .filter((entry) => direction === undefined || entry.direction === direction)
      .filter((entry) => outcome === undefined || entry.outcome === outcome)
      .slice(effectiveLimit === 0 ? this.history.length : -effectiveLimit)
      .map(clonePublic);
  }

  clearHistory() {
    const cleared = this.history.length;
    this.history.length = 0;
    return cleared;
  }

  getStatus() {
    return {
      closed: this.closed,
      pending_count: this.pending.size,
      max_pending: this.maxPending,
      history_count: this.history.length,
      skipped_out_of_scope: this.skippedOutOfScope,
      default_timeout_ms: this.defaultTimeoutMs,
      default_action: this.defaultAction,
      redacted: true,
      sensitive_reads_available: this.allowSensitive,
    };
  }

  #assertSensitiveRead(includeSensitive) {
    if (includeSensitive !== true) return;
    if (!this.allowSensitive) {
      throw new BreakpointError(
        'SENSITIVE_BREAKPOINT_ACCESS_NOT_GRANTED',
        'Sensitive breakpoint reads require the server-level sensitive-data grant.',
        { recovery: ['Restart a trusted local session with PROXY_MATE_ALLOW_SENSITIVE=1.'] },
      );
    }
  }

  #nextId(now) {
    this.sequence += 1;
    const generated = this.idFactory
      ? this.idFactory({ sequence: this.sequence, timestamp: now })
      : `bp_${now.toString(36)}_${this.sequence.toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
    if (typeof generated !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(generated)) {
      throw invalidConfig('idFactory must return a non-empty identifier containing only letters, digits, dot, underscore, colon, or hyphen.');
    }
    if (this.pending.has(generated) || this.history.some((entry) => entry.id === generated)) {
      throw invalidConfig(`idFactory generated duplicate breakpoint ID ${generated}.`);
    }
    return generated;
  }

  #complete(id, { outcome, action, decision, defaulted, reason }) {
    const entry = this.pending.get(id);
    if (!entry) throw notFound(id);
    const normalized = decision ?? { action };
    const callbackResult = mapAction(entry.publicRecord.direction, normalized, this.maxBodyBytes);
    clearTimeout(entry.timer);
    this.pending.delete(id);
    const history = this.#historyRecord(entry.publicRecord, {
      outcome,
      action,
      defaulted,
      reason,
      changedFields: changedFields(normalized),
    });
    this.#pushHistory(history);
    entry.resolve(callbackResult);
    return clonePublic(history);
  }

  #historyRecord(record, { outcome, action, defaulted, reason, changedFields = [] }) {
    const completedAt = this.clock();
    const createdAt = Date.parse(record.created_at);
    return Object.freeze({
      id: record.id,
      owner: record.owner,
      scope: record.scope,
      rule_id: record.rule_id,
      direction: record.direction,
      outcome,
      action,
      defaulted,
      reason: reason ?? null,
      changed_fields: changedFields,
      created_at: record.created_at,
      deadline_at: record.deadline_at,
      completed_at: toTimestamp(completedAt),
      duration_ms: Math.max(0, completedAt - createdAt),
    });
  }

  #pushHistory(entry) {
    if (this.maxHistory === 0) return;
    this.history.push(entry);
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }
  }
}

export function createMockttpBreakpointCallbacks(manager, {
  ruleId,
  request = true,
  response = true,
  timeoutMs,
  defaultAction,
  owner, scope = 'all', inScope = () => false,
} = {}) {
  if (!manager || typeof manager.pause !== 'function') {
    throw new BreakpointError('INVALID_BREAKPOINT_MANAGER', 'manager must provide a pause function.');
  }
  validateRuleId(ruleId);
  return {
    ...(request ? {
      beforeRequest: (message) => manager.pause({
        ruleId, direction: 'request', message, timeoutMs, defaultAction, owner, scope,
        inScope: scope === 'all' || inScope(message),
      }),
    } : {}),
    ...(response ? {
      beforeResponse: (responseMessage, requestMessage) => manager.pause({
        ruleId,
        direction: 'response',
        message: { response: responseMessage, request: requestMessage },
        owner, scope, inScope: scope === 'all' || inScope(requestMessage),
        timeoutMs,
        defaultAction,
      }),
    } : {}),
  };
}

function validateDecision(direction, decision, maxBodyBytes) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    throw new BreakpointError('INVALID_BREAKPOINT_DECISION', 'decision must be an object containing an action.');
  }
  const action = decision.action;
  if (!ACTIONS.has(action)) {
    throw new BreakpointError('INVALID_BREAKPOINT_ACTION', `action must be one of ${[...ACTIONS].join(', ')}.`);
  }
  if (action === 'modify') {
    const changes = decision.changes ?? decision.modification;
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      throw new BreakpointError('BREAKPOINT_CHANGES_REQUIRED', 'modify requires a changes object.');
    }
    return { action, changes: validateModification(direction, changes, maxBodyBytes) };
  }
  if (action === 'respond') {
    if (direction !== 'request') {
      throw new BreakpointError('BREAKPOINT_RESPONSE_ONLY_AT_REQUEST', 'respond is only valid for request breakpoints; use modify for a received response.');
    }
    const response = decision.response ?? decision.changes;
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      throw new BreakpointError('BREAKPOINT_RESPONSE_REQUIRED', 'respond requires a response object.');
    }
    return { action, response: validateResponse(response, maxBodyBytes, { requireStatus: true }) };
  }
  return { action };
}

function mapAction(direction, decision, maxBodyBytes) {
  switch (decision.action) {
    case 'continue': return {};
    case 'modify': return decision.changes ?? validateModification(direction, decision.modification, maxBodyBytes);
    case 'respond': return { response: decision.response };
    case 'abort': {
      const response = {
        statusCode: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
        body: 'Request aborted by proxy-mate breakpoint',
      };
      return direction === 'request' ? { response } : response;
    }
    case 'close': return direction === 'request' ? { response: 'close' } : 'close';
    case 'reset': return direction === 'request' ? { response: 'reset' } : 'reset';
    default: throw new BreakpointError('INVALID_BREAKPOINT_ACTION', `Unsupported action ${decision.action}.`);
  }
}

function validateModification(direction, input, maxBodyBytes) {
  const allowed = direction === 'request'
    ? new Set(['method', 'url', 'headers', 'body', 'body_base64', 'rawBody', 'json'])
    : new Set(['status', 'statusCode', 'statusMessage', 'headers', 'trailers', 'body', 'body_base64', 'rawBody', 'json']);
  rejectUnknownFields(input, allowed, 'modification');
  const output = {};

  if (direction === 'request') {
    if (input.method !== undefined) {
      if (typeof input.method !== 'string' || !METHOD.test(input.method)) {
        throw new BreakpointError('INVALID_BREAKPOINT_METHOD', 'method must be a valid HTTP method token.');
      }
      output.method = input.method.toUpperCase();
    }
    if (input.url !== undefined) output.url = validateUrl(input.url);
  } else {
    const status = input.statusCode ?? input.status;
    if (status !== undefined) output.statusCode = validateStatus(status);
    if (input.statusMessage !== undefined) output.statusMessage = validateStatusMessage(input.statusMessage);
  }

  if (input.headers !== undefined) output.headers = validateHeaders(input.headers, 'headers');
  if (input.trailers !== undefined) output.trailers = validateHeaders(input.trailers, 'trailers');
  Object.assign(output, validateBodyFields(input, maxBodyBytes));
  if (Object.keys(output).length === 0) {
    throw new BreakpointError('EMPTY_BREAKPOINT_MODIFICATION', 'changes must modify at least one field.');
  }
  return output;
}

function validateResponse(input, maxBodyBytes, { requireStatus = false } = {}) {
  const allowed = new Set(['status', 'statusCode', 'statusMessage', 'headers', 'trailers', 'body', 'body_base64', 'rawBody', 'json']);
  rejectUnknownFields(input, allowed, 'response');
  const output = {};
  const status = input.statusCode ?? input.status;
  if (requireStatus && status === undefined) {
    throw new BreakpointError('BREAKPOINT_STATUS_REQUIRED', 'response.statusCode is required.');
  }
  if (status !== undefined) output.statusCode = validateStatus(status);
  if (input.statusMessage !== undefined) output.statusMessage = validateStatusMessage(input.statusMessage);
  if (input.headers !== undefined) output.headers = validateHeaders(input.headers, 'headers');
  if (input.trailers !== undefined) output.trailers = validateHeaders(input.trailers, 'trailers');
  Object.assign(output, validateBodyFields(input, maxBodyBytes));
  return output;
}

function validateBodyFields(input, maxBodyBytes) {
  const fields = ['body', 'body_base64', 'rawBody', 'json'].filter((field) => Object.hasOwn(input, field));
  if (fields.length > 1) {
    throw new BreakpointError('MULTIPLE_BREAKPOINT_BODIES', 'Use only one of body, body_base64, rawBody, or json.');
  }
  if (fields.length === 0) return {};
  const field = fields[0];
  if (field === 'body_base64') {
    if (typeof input.body_base64 !== 'string' || !isCanonicalBase64(input.body_base64)) {
      throw new BreakpointError('INVALID_BREAKPOINT_BASE64', 'body_base64 must be valid canonical base64.');
    }
    const value = Buffer.from(input.body_base64, 'base64');
    enforceBodyLimit(value.byteLength, maxBodyBytes);
    return { rawBody: value };
  }
  if (field === 'json') {
    const value = cloneJson(input.json);
    enforceBodyLimit(Buffer.byteLength(JSON.stringify(value)), maxBodyBytes);
    return { json: value };
  }
  const value = input[field];
  if (typeof value !== 'string' && !Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new BreakpointError('INVALID_BREAKPOINT_BODY', `${field} must be a string, Buffer, or Uint8Array.`);
  }
  const size = typeof value === 'string' ? Buffer.byteLength(value) : value.byteLength;
  enforceBodyLimit(size, maxBodyBytes);
  if (field === 'rawBody') return { rawBody: Buffer.from(value) };
  return { body: typeof value === 'string' ? value : Buffer.from(value) };
}

function validateHeaders(input, field) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BreakpointError('INVALID_BREAKPOINT_HEADERS', `${field} must be an object.`);
  }
  const entries = Object.entries(input);
  if (entries.length > 200) throw new BreakpointError('TOO_MANY_BREAKPOINT_HEADERS', `${field} cannot contain more than 200 fields.`);
  let bytes = 0;
  const output = {};
  for (const [name, rawValue] of entries) {
    if (!HEADER_NAME.test(name)) throw new BreakpointError('INVALID_BREAKPOINT_HEADER_NAME', `Invalid HTTP header name: ${name}`);
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    if (values.length === 0 || values.some((value) => typeof value !== 'string' || /[\r\n]/.test(value))) {
      throw new BreakpointError('INVALID_BREAKPOINT_HEADER_VALUE', `Header ${name} must contain a string or non-empty string array without CR/LF.`);
    }
    bytes += Buffer.byteLength(name) + values.reduce((total, value) => total + Buffer.byteLength(value), 0);
    output[name] = Array.isArray(rawValue) ? [...values] : values[0];
  }
  if (bytes > 64 * 1024) throw new BreakpointError('BREAKPOINT_HEADERS_TOO_LARGE', `${field} exceeds 65536 bytes.`);
  return output;
}

function validateStatus(value) {
  if (!Number.isInteger(value) || value < 100 || value > 599) {
    throw new BreakpointError('INVALID_BREAKPOINT_STATUS', 'statusCode must be an integer from 100 through 599.');
  }
  return value;
}

function validateStatusMessage(value) {
  if (typeof value !== 'string' || value.length > 1024 || /[\r\n]/.test(value)) {
    throw new BreakpointError('INVALID_BREAKPOINT_STATUS_MESSAGE', 'statusMessage must be a string of at most 1024 characters without CR/LF.');
  }
  return value;
}

function validateUrl(value) {
  if (typeof value !== 'string' || value.length > 32 * 1024) {
    throw new BreakpointError('INVALID_BREAKPOINT_URL', 'url must be an absolute HTTP(S) URL no longer than 32768 characters.');
  }
  let parsed;
  try { parsed = new URL(value); } catch {
    throw new BreakpointError('INVALID_BREAKPOINT_URL', 'url must be an absolute HTTP(S) URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new BreakpointError('INVALID_BREAKPOINT_URL', 'url must use HTTP(S) and cannot contain credentials.');
  }
  return parsed.toString();
}

function snapshotMessage(direction, message, options) {
  const request = direction === 'request' ? (message.request ?? message) : message.request;
  const response = direction === 'response' ? (message.response ?? message) : undefined;
  return {
    request: request ? snapshotRequest(request, options) : null,
    response: response ? snapshotResponse(response, options) : null,
  };
}

function snapshotRequest(message, options) {
  const headers = snapshotHeaders(message.headers, options.allowSensitive);
  return {
    id: scalar(message.id),
    method: scalar(message.method),
    url: options.allowSensitive ? scalar(message.url) : redactCapturedUrl(message.url),
    protocol: scalar(message.protocol),
    http_version: scalar(message.httpVersion ?? message.http_version),
    hostname: scalar(message.hostname),
    path: scalar(message.path),
    headers,
    body: bodyPreview(message, headers, options),
  };
}

function snapshotResponse(message, options) {
  const headers = snapshotHeaders(message.headers, options.allowSensitive);
  return {
    id: scalar(message.id),
    status_code: Number.isInteger(message.statusCode) ? message.statusCode : null,
    status_message: scalar(message.statusMessage),
    http_version: scalar(message.httpVersion ?? message.http_version),
    headers,
    trailers: snapshotHeaders(message.trailers, options.allowSensitive),
    body: bodyPreview(message, headers, options),
  };
}

function snapshotHeaders(headers, allowSensitive) {
  if (!headers || typeof headers !== 'object') return {};
  const snapshot = Object.fromEntries(Object.entries(headers).map(([name, raw]) => {
    const value = Array.isArray(raw) ? raw.map(String) : String(raw);
    return [name, value];
  }));
  return allowSensitive ? snapshot : redactCapturedHeaders(snapshot);
}

function bodyPreview(message, headers, { allowSensitive, maxPreviewBytes }) {
  const value = bodyValue(message);
  if (value === undefined) return { size: 0, returned_bytes: 0, truncated: false, encoding: 'none', preview: '' };
  let buffer;
  let wasString = false;
  if (typeof value === 'string') {
    wasString = true;
    buffer = Buffer.from(value);
  } else if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    buffer = Buffer.from(value);
  } else {
    try {
      wasString = true;
      buffer = Buffer.from(JSON.stringify(value));
    } catch {
      return { size: null, returned_bytes: 0, truncated: false, encoding: 'unavailable', preview: null };
    }
  }
  const returned = buffer.subarray(0, maxPreviewBytes);
  const contentType = headerValue(headers, 'content-type');
  const textual = wasString || isTextual(contentType) || isUtf8(returned);
  if (!textual && !allowSensitive) {
    return {
      size: buffer.length,
      returned_bytes: 0,
      truncated: buffer.length > 0,
      encoding: 'binary-omitted',
      preview: null,
    };
  }
  const encoding = textual ? 'utf8' : 'base64';
  let preview = textual ? returned.toString('utf8') : returned.toString('base64');
  if (textual && !allowSensitive) preview = redactCapturedBody(preview, headers);
  return {
    size: buffer.length,
    returned_bytes: returned.length,
    truncated: returned.length < buffer.length,
    encoding,
    preview,
  };
}

function bodyValue(message) {
  if (typeof message.body === 'string' || Buffer.isBuffer(message.body) || message.body instanceof Uint8Array) return message.body;
  if (message.body?.buffer !== undefined && (
    Buffer.isBuffer(message.body.buffer)
    || message.body.buffer instanceof Uint8Array
    || message.body.buffer instanceof ArrayBuffer
  )) return message.body.buffer;
  if (message.body_inline !== undefined) return message.body_inline;
  if (message.rawBody !== undefined) return message.rawBody;
  if (message.body !== undefined && typeof message.body !== 'object') return message.body;
  if (message.json !== undefined) return message.json;
  return undefined;
}

function headerValue(headers, name) {
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name);
  if (!entry) return '';
  return Array.isArray(entry[1]) ? entry[1].join(', ') : String(entry[1]);
}

function isTextual(contentType) {
  return /(^text\/|json|javascript|xml|yaml|graphql|x-www-form-urlencoded)/i.test(contentType ?? '');
}

function isUtf8(buffer) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return !buffer.includes(0);
  } catch {
    return false;
  }
}

function changedFields(decision) {
  if (decision.action === 'modify') return Object.keys(decision.changes).sort();
  if (decision.action === 'respond') return Object.keys(decision.response).sort();
  return [];
}

function cloneJson(value) {
  try {
    validateJsonValue(value, new Set());
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('not JSON');
    return JSON.parse(serialized);
  } catch {
    throw new BreakpointError('INVALID_BREAKPOINT_JSON', 'json must be a finite, serializable JSON value without cycles.');
  }
}

function validateJsonValue(value, seen) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number');
    return;
  }
  if (typeof value !== 'object' || seen.has(value)) throw new Error('non-JSON value');
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) validateJsonValue(child, seen);
  } else {
    for (const child of Object.values(value)) validateJsonValue(child, seen);
  }
  seen.delete(value);
}

function isCanonicalBase64(value) {
  if (value === '') return true;
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function rejectUnknownFields(input, allowed, label) {
  const unknown = Object.keys(input).filter((field) => !allowed.has(field));
  if (unknown.length > 0) {
    throw new BreakpointError('UNKNOWN_BREAKPOINT_FIELD', `Unknown ${label} field(s): ${unknown.join(', ')}.`, { details: { fields: unknown } });
  }
}

function enforceBodyLimit(size, maxBodyBytes) {
  if (size > maxBodyBytes) {
    throw new BreakpointError('BREAKPOINT_BODY_TOO_LARGE', `Breakpoint body exceeds ${maxBodyBytes} bytes.`, {
      details: { body_bytes: size, max_body_bytes: maxBodyBytes },
    });
  }
}

function validateFallbackAction(action) {
  if (!['continue', 'abort', 'close', 'reset'].includes(action)) {
    throw invalidConfig('A breakpoint fallback action must be continue, abort, close, or reset.');
  }
  return action;
}

function validateRuleId(ruleId) {
  if (typeof ruleId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(ruleId)) {
    throw new BreakpointError('INVALID_BREAKPOINT_RULE_ID', 'ruleId must contain 1-160 letters, digits, dot, underscore, colon, or hyphen.');
  }
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) throw invalidConfig(`${name} must be a positive integer.`);
  return value;
}

function nonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) throw invalidConfig(`${name} must be a non-negative integer.`);
  return value;
}

function invalidConfig(message) {
  return new BreakpointError('INVALID_BREAKPOINT_CONFIG', message);
}

function notFound(id) {
  return new BreakpointError('BREAKPOINT_NOT_PENDING', `Breakpoint ${id} is not pending.`, {
    recovery: ['List pending breakpoints and resolve one before its deadline.'],
  });
}

function safeReason(value) {
  if (typeof value !== 'string' || value.length > 1024 || /[\r\n]/.test(value)) {
    throw new BreakpointError('INVALID_BREAKPOINT_REASON', 'reason must be a string of at most 1024 characters without CR/LF.');
  }
  return value;
}

function scalar(value) {
  if (value === undefined || value === null) return null;
  return ['string', 'number', 'boolean'].includes(typeof value) ? value : String(value);
}

function toTimestamp(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw invalidConfig('clock must return a valid epoch timestamp.');
  return date.toISOString();
}

function clonePublic(value) {
  return structuredClone(value);
}

// Refresh off the request path. A cold or failed snapshot safely skips pauses.
export function createBreakpointScope({ listClaims, isAlive = () => true, now = Date.now }) {
  let snapshot = [], refreshed = -Infinity, refreshing = false;
  return ({ owner, hostname, device_udid }) => {
    const at = now();
    if (!refreshing && at - refreshed >= 1000) {
      refreshing = true; refreshed = at;
      Promise.resolve().then(listClaims).then(rows => {
        snapshot = rows.map(c => ({ ...c, hosts: c.domains.map(domain => new RegExp('^' + domain.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')) }));
      }).catch(() => { snapshot = []; }).finally(() => { refreshing = false; });
    }
    const active = snapshot.filter(c => Date.parse(c.expires_at) > at);
    const mine = active.filter(c => c.client_id === owner?.client_id && (c.task_id ?? null) === (owner?.task_id ?? null));
    if (device_udid) {
      if (mine.some(c => c.device_udids?.some(id => id.toUpperCase() === device_udid.toUpperCase()))) return true;
      // A known foreign device must never fall back to the owner's host claim.
      if (active.some(c => c.device_udids?.some(id => id.toUpperCase() === device_udid.toUpperCase()))) return false;
    }
    const covers = c => c.hosts.some(h => h.test(hostname ?? ''));
    return mine.some(covers) && !active.some(c => c.client_id !== owner?.client_id && isAlive(c.client_id) && covers(c));
  };
}
