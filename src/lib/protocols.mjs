import { spawn } from 'node:child_process';

const MAX_PROTOBUF_INPUT = 16 * 1024 * 1024;
const MAX_PROTOBUF_OUTPUT = 4 * 1024 * 1024;

/** Compact, static capability descriptor for protocol-aware callers. */
export function protocolCapabilities() {
  return {
    graphql: { inspect: true, batches: true, operation_name_matching: true },
    grpc: { framing: true, grpc_web_trailers: true, compression_metadata: true, protobuf_decode: true },
    openapi: { version: '3.x', json: true, local_external_refs: true, remote_fetch: false, session_validation: true },
    websocket: { transcript_data: true, live_frame_injection: false },
  };
}

/** Inspect GraphQL JSON requests, including batches and documents with several operations. */
export function inspectGraphQLBody(body) {
  let value;
  try { value = typeof body === 'string' || Buffer.isBuffer(body) ? JSON.parse(Buffer.from(body).toString('utf8')) : body; }
  catch { return { detected: false, error: { code: 'INVALID_JSON', message: 'GraphQL HTTP body is not valid JSON.' }, operations: [] }; }
  const entries = Array.isArray(value) ? value : [value];
  const operations = entries.map((entry, index) => inspectGraphQLEntry(entry, index));
  return { detected: operations.some((operation) => operation.query), batch: Array.isArray(value), operations };
}

export function createGraphQLOperationMatcher(expected) {
  return (operation) => matchesGraphQLOperationName(operation, expected);
}

/** A rule-friendly matcher. expected can be a name, list of names, RegExp, or predicate. */
export function matchesGraphQLOperationName(operation, expected) {
  const name = typeof operation === 'string' ? operation : operation?.operation_name;
  if (typeof expected === 'function') return Boolean(expected(operation));
  if (expected instanceof RegExp) return expected.test(name ?? '');
  if (Array.isArray(expected)) return expected.some((item) => matchesGraphQLOperationName(operation, item));
  return typeof expected === 'string' && name === expected;
}

function inspectGraphQLEntry(entry, index) {
  const query = typeof entry?.query === 'string' ? entry.query : '';
  const definitions = parseGraphQLOperations(query);
  const requestedName = typeof entry?.operationName === 'string' && entry.operationName ? entry.operationName : null;
  const selected = requestedName ? definitions.find((definition) => definition.operation_name === requestedName) : definitions.length === 1 ? definitions[0] : null;
  return {
    index, query, variables: entry?.variables ?? null,
    requested_operation_name: requestedName,
    operation_name: selected?.operation_name ?? requestedName ?? (definitions.length === 1 ? definitions[0].operation_name : null),
    operation_type: selected?.operation_type ?? (definitions.length === 1 ? definitions[0].operation_type : null),
    definitions,
    anonymous: selected?.anonymous ?? (definitions.length === 1 && definitions[0].anonymous),
    error: requestedName && !selected ? { code: 'OPERATION_NAME_NOT_FOUND', message: `No operation named ${requestedName} exists in the GraphQL document.` } : null,
  };
}

// This intentionally is a small lexer, not a GraphQL validator. It skips quoted
// strings/comments so words inside a query never become phantom operations.
export function parseGraphQLOperations(query) {
  if (typeof query !== 'string') return [];
  const source = stripGraphQLLiterals(query);
  const out = [];
  const re = /(^|[{}\s,])(query|mutation|subscription)\b\s*([_A-Za-z][_0-9A-Za-z]*)?/g;
  let match;
  while ((match = re.exec(source))) {
    // A keyword in a field selection has a preceding '{'; real definitions
    // occur at document depth zero, which is cheap to establish here.
    if (braceDepth(source, match.index + match[1].length) !== 0) continue;
    out.push({ operation_type: match[2], operation_name: match[3] ?? null, anonymous: !match[3] });
  }
  if (out.length === 0 && /^\s*\{/.test(source)) out.push({ operation_type: 'query', operation_name: null, anonymous: true });
  return out;
}

function stripGraphQLLiterals(source) {
  let result = ''; let i = 0;
  while (i < source.length) {
    if (source[i] === '#') { while (i < source.length && source[i] !== '\n') { result += ' '; i += 1; } continue; }
    if (source.startsWith('"""', i)) { result += '   '; i += 3; while (i < source.length && !source.startsWith('"""', i)) { result += source[i] === '\n' ? '\n' : ' '; i += 1; } result += '   '; i += 3; continue; }
    if (source[i] === '"') { result += ' '; i += 1; while (i < source.length) { const ch = source[i]; result += ch === '\n' ? '\n' : ' '; i += 1; if (ch === '\\') { result += ' '; i += 1; } else if (ch === '"') break; } continue; }
    result += source[i++];
  }
  return result;
}
function braceDepth(source, end) { let depth = 0; for (let i = 0; i < end; i += 1) { if (source[i] === '{') depth += 1; if (source[i] === '}') depth -= 1; } return depth; }

/** Parse gRPC and gRPC-web frames. Trailer frames are decoded as ASCII headers. */
export function parseGrpcFrames(input, { contentEncoding = null } = {}) {
  const buffer = Buffer.from(input ?? []); const frames = []; let offset = 0;
  while (offset < buffer.length) {
    if (buffer.length - offset < 5) return { valid: false, frames, error: { code: 'TRUNCATED_GRPC_HEADER', offset } };
    const flags = buffer[offset];
    if ((flags & ~0x81) !== 0) return { valid: false, frames, error: { code: 'INVALID_GRPC_FLAGS', offset, flags } };
    const length = buffer.readUInt32BE(offset + 1); const start = offset + 5; const end = start + length;
    if (end > buffer.length) return { valid: false, frames, error: { code: 'TRUNCATED_GRPC_MESSAGE', offset, declared_length: length, available: buffer.length - start } };
    const payload = buffer.subarray(start, end); const trailer = Boolean(flags & 0x80); const compressed = Boolean(flags & 1);
    const frame = { index: frames.length, compressed, compression: compressed ? (contentEncoding ?? 'unknown') : null, trailer, length, payload };
    if (trailer) frame.trailers = parseGrpcWebTrailers(payload);
    frames.push(frame); offset = end;
  }
  return { valid: true, frames, grpc_web: frames.some((frame) => frame.trailer), compression: contentEncoding ?? null };
}

export function parseGrpcWebTrailers(payload) {
  const headers = {};
  for (const line of Buffer.from(payload).toString('utf8').split(/\r?\n/)) {
    const index = line.indexOf(':'); if (index < 1) continue;
    const name = line.slice(0, index).trim().toLowerCase(); const value = line.slice(index + 1).trim();
    if (name) headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }
  return headers;
}

/** Cache descriptor selections; callers can reuse it around repeated decode requests. */
export class ProtobufDescriptorCache {
  constructor({ maxEntries = 100 } = {}) { this.maxEntries = Math.max(1, Number(maxEntries) || 100); this.entries = new Map(); }
  get(descriptor_path, message_type) { const key = this.#key(descriptor_path, message_type); const value = this.entries.get(key); if (value) { this.entries.delete(key); this.entries.set(key, value); } return value ?? null; }
  set(descriptor_path, message_type, value = { descriptor_path, message_type }) { const key = this.#key(descriptor_path, message_type); this.entries.delete(key); this.entries.set(key, value); while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value); return value; }
  clear() { this.entries.clear(); }
  #key(path, type) { return `${String(path ?? '')}\u0000${String(type ?? '')}`; }
}

export async function decodeProtobuf(buffer, { protoc = 'protoc', descriptor_path, message_type, timeout_ms = 15_000 } = {}) {
  const input = Buffer.from(buffer ?? []);
  if (input.length > MAX_PROTOBUF_INPUT) throw codedError('PROTOBUF_INPUT_TOO_LARGE', `Protobuf input exceeds ${MAX_PROTOBUF_INPUT} bytes.`);
  if ((descriptor_path && !message_type) || (!descriptor_path && message_type)) throw codedError('PROTOBUF_SCHEMA_INCOMPLETE', 'descriptor_path and message_type must be provided together.');
  const args = descriptor_path ? [`--descriptor_set_in=${descriptor_path}`, `--decode=${message_type}`] : ['--decode_raw'];
  return new Promise((resolve, reject) => {
    const child = spawn(protoc, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false }); const stdout = []; const stderr = []; let outputBytes = 0;
    const timer = setTimeout(() => child.kill('SIGTERM'), Math.max(100, timeout_ms));
    child.stdout.on('data', (chunk) => { outputBytes += chunk.length; if (outputBytes > MAX_PROTOBUF_OUTPUT) child.kill('SIGTERM'); else stdout.push(chunk); });
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => { clearTimeout(timer); reject(codedError(error.code === 'ENOENT' ? 'PROTOC_NOT_FOUND' : 'PROTOC_FAILED', error.code === 'ENOENT' ? 'protoc is not installed or not on PATH.' : error.message, ['Install Protocol Buffers with Homebrew or pass an explicit protoc executable path.'])); });
    child.once('close', (code, signal) => { clearTimeout(timer); if (outputBytes > MAX_PROTOBUF_OUTPUT) return reject(codedError('PROTOBUF_OUTPUT_TOO_LARGE', 'Decoded protobuf output exceeded the safety limit.')); if (signal) return reject(codedError('PROTOBUF_DECODE_TIMEOUT', 'protoc decoding timed out.')); const errorText = Buffer.concat(stderr).toString('utf8').trim(); if (code !== 0) return reject(codedError('PROTOBUF_DECODE_FAILED', errorText || `protoc exited with status ${code}`)); resolve({ decoded_text: Buffer.concat(stdout).toString('utf8'), schema_aware: Boolean(descriptor_path), message_type: message_type ?? null }); });
    child.stdin.end(input);
  });
}

function codedError(code, message, recovery) { const error = new Error(message); error.code = code; error.retryable = code === 'PROTOC_NOT_FOUND'; if (recovery) error.recovery = recovery; return error; }
