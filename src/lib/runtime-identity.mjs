import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_VERSION, STATE_DIR } from './config.mjs';
import { atomicWriteJson } from './state.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export async function runtimeIdentity() {
  let marker = null;
  try { marker = JSON.parse(await fs.readFile(path.join(root, '.proxy-runtime.json'), 'utf8')); } catch { /* checkout */ }
  return { version: SERVER_VERSION, node: process.version, node_executable: process.execPath,
    entry_root: root, installed: ['proxy-mate', 'proxy-mcp'].includes(marker?.managed_by),
    content_sha256: marker?.content_sha256 ?? null, dependency_lock_sha256: marker?.dependency_lock_sha256 ?? null,
    staged_at: marker?.staged_at ?? null };
}

export async function readRuntimeEvents(source = 'daemon') {
  const file = path.join(STATE_DIR, `${source}.events.json`);
  try {
    if ((await fs.stat(file)).size > 256 * 1024) return [];
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    return Array.isArray(data) ? data.slice(-64) : [];
  } catch { return []; }
}

// `details` carries extra scalar diagnostics (load, timings, ports, step).
// Reserved keys and non-scalar values are dropped so events stay small.
const RESERVED_EVENT_KEYS = new Set(['event', 'reason', 'code', 'pid', 'node', 'at']);
export function eventDetails(details) {
  const out = {};
  for (const [key, value] of Object.entries(details ?? {})) {
    if (RESERVED_EVENT_KEYS.has(key) || !/^[a-z][a-z0-9_]{0,63}$/.test(key)) continue;
    if (value === null || ['number', 'boolean'].includes(typeof value)) out[key] = value;
    else if (typeof value === 'string') out[key] = value.slice(0, 300);
  }
  return out;
}

let mutation = Promise.resolve();
export function recordRuntimeEvent(event, { source = 'daemon', reason, code, pid = process.pid, details } = {}) {
  const operation = mutation.then(async () => {
    const events = await readRuntimeEvents(source);
    events.push({ event, reason, code, pid, node: process.version, at: new Date().toISOString(), ...eventDetails(details) });
    await atomicWriteJson(path.join(STATE_DIR, `${source}.events.json`), events.slice(-64));
  });
  mutation = operation.catch(() => {});
  return operation;
}
