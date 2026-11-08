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
    entry_root: root, installed: marker?.managed_by === 'proxy-mcp',
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

let mutation = Promise.resolve();
export function recordRuntimeEvent(event, { source = 'daemon', reason, code, pid = process.pid } = {}) {
  const operation = mutation.then(async () => {
    const events = await readRuntimeEvents(source);
    events.push({ event, reason, code, pid, node: process.version, at: new Date().toISOString() });
    await atomicWriteJson(path.join(STATE_DIR, `${source}.events.json`), events.slice(-64));
  });
  mutation = operation.catch(() => {});
  return operation;
}
