// Large-body disk storage for captured flows and mock rules.
//
// Rule of thumb: bodies > LARGE_BODY_THRESHOLD bytes are written to disk and
// referenced by path. This keeps the MCP tool-result budget safe and lets
// mock rules cheaply replay multi-MB payloads via mockttp's thenFromFile.

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_DIR } from './config.mjs';

const FLOW_BODIES_DIR = path.join(STATE_DIR, 'bodies', 'flows');
const MOCK_BODIES_DIR = path.join(STATE_DIR, 'bodies', 'mocks');

export const LARGE_BODY_THRESHOLD = 65536; // 64 KB
export const INLINE_BODY_CAP = 32768;       // 32 KB returned inline in tool results

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function flowBodyPath(flowId, kind /* 'req' | 'res' */) {
  return path.join(FLOW_BODIES_DIR, `${safeFilePart(flowId, 'flowId')}.${kind}.bin`);
}

export function mockBodyPath(ruleId, version = null) {
  const base = safeFilePart(ruleId, 'ruleId');
  const suffix = version ? `.${safeFilePart(version, 'version')}` : '';
  return path.join(MOCK_BODIES_DIR, `${base}${suffix}.bin`);
}

export function safeFilePart(value, label = 'value') {
  const part = String(value ?? '');
  if (!part || !/^[A-Za-z0-9._-]+$/.test(part) || part === '.' || part === '..') {
    throw new Error(`${label} may only contain letters, numbers, dot, underscore, and hyphen`);
  }
  return part;
}

// Persist a captured body if it's large enough to be worth spilling.
// Returns { inline: string | null, path: string | null, size: number, sha: string }.
export async function storeFlowBody(buf, flowId, kind, decoded = {}) {
  if (!buf || buf.length === 0) {
    return { inline: '', path: null, size: 0, sha: null };
  }
  const size = buf.length;
  const sha = sha256(buf);
  const text = Object.hasOwn(decoded, 'text') ? decoded.text : bufToText(buf);
  if (size <= LARGE_BODY_THRESHOLD && text !== null) {
    return { inline: text, path: null, size, sha, encoding: 'utf8' };
  }
  await ensureDir(FLOW_BODIES_DIR);
  const p = flowBodyPath(flowId, kind);
  await fs.writeFile(p, buf, { mode: 0o600 });
  return { inline: null, path: p, size, sha, encoding: text === null ? 'binary' : 'utf8' };
}

// Best-effort text decode; binary payloads return null and only the path matters.
function bufToText(buf) {
  try {
    const s = buf.toString('utf8');
    // Reject decode if the round-trip lost bytes (binary payload).
    if (Buffer.byteLength(s, 'utf8') === buf.length) return s;
    return null;
  } catch {
    return null;
  }
}

// Read a stored body, returning a Buffer (or null if missing).
export async function readStoredBody(p) {
  if (!p) return null;
  try { return await fs.readFile(p); } catch { return null; }
}

// Write an inline string body to a deterministic mock-bodies file. Used when
// callers pass `body:` inline so create_map_local can still use thenFromFile.
export async function writeMockBody(ruleId, content) {
  await ensureDir(MOCK_BODIES_DIR);
  const p = mockBodyPath(ruleId, crypto.randomBytes(8).toString('hex'));
  await fs.writeFile(p, content, { encoding: typeof content === 'string' ? 'utf8' : undefined, mode: 0o600 });
  return p;
}

// Truncate inline body for tool-result returns. Returns { text, truncated, original_size }.
export function truncateInline(text, cap = INLINE_BODY_CAP) {
  if (text == null) return { text: null, truncated: false, original_size: 0 };
  const size = Buffer.byteLength(text, 'utf8');
  if (size <= cap) return { text, truncated: false, original_size: size };
  const bytes = Buffer.from(text, 'utf8');
  let end = Math.min(cap, bytes.length);
  let preview = '';
  while (end > 0) {
    try { preview = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end)); break; }
    catch { end--; }
  }
  return { text: preview + '…[truncated]', truncated: true, original_size: size };
}

// Copy a stored flow-body to a caller-specified path. Used by save_body_to_file.
export async function exportBody(srcPath, destPath) {
  if (!srcPath || !existsSync(srcPath)) throw new Error(`source body not found: ${srcPath}`);
  await ensureDir(path.dirname(destPath));
  await fs.copyFile(srcPath, destPath);
  return destPath;
}

// Promote a stored flow-body into a mock-body for capture_to_mock. Falls back
// to writing the inline text when the source wasn't spilled to disk.
export async function flowBodyToMockBody({ ruleId, srcPath, inlineText }) {
  await ensureDir(MOCK_BODIES_DIR);
  const dest = mockBodyPath(ruleId, crypto.randomBytes(8).toString('hex'));
  if (srcPath) {
    await fs.copyFile(srcPath, dest);
  } else {
    await fs.writeFile(dest, inlineText ?? '', { encoding: 'utf8', mode: 0o600 });
  }
  return dest;
}

export async function deleteFlowBodies(flowId) {
  await Promise.all(['req', 'res'].map(async (kind) => {
    try { await fs.unlink(flowBodyPath(flowId, kind)); } catch { /* absent is fine */ }
  }));
}

export async function clearFlowBodies() {
  let names;
  try { names = await fs.readdir(FLOW_BODIES_DIR); } catch { return; }
  await Promise.all(names.map(async (name) => {
    const target = path.join(FLOW_BODIES_DIR, name);
    try { await fs.unlink(target); } catch { /* best effort */ }
  }));
}
