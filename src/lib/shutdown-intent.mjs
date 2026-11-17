import { promises as fs } from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './config.mjs';
import { atomicWriteJson } from './state.mjs';

// The guardian (or any supervisor) records why it is about to signal the
// daemon BEFORE sending SIGTERM. The daemon reads it in its shutdown handler so
// its `stopping` event names the real cause instead of `requested_shutdown`.
// An intent is valid only for the named pid and for INTENT_TTL_MS.

export const INTENT_TTL_MS = 120_000;
const fileFor = (directory) => path.join(directory, 'shutdown-intent.json');

export async function writeShutdownIntent({ targetPid, reason, by, directory = STATE_DIR, now = Date.now } = {}) {
  if (!Number.isInteger(targetPid) || typeof reason !== 'string' || !reason) throw new TypeError('targetPid and reason are required');
  await atomicWriteJson(fileFor(directory), { target_pid: targetPid, reason, by: by ?? null, at: new Date(now()).toISOString() }, 0o600);
}

export async function readShutdownIntent(targetPid, { directory = STATE_DIR, now = Date.now } = {}) {
  try {
    const intent = JSON.parse(await fs.readFile(fileFor(directory), 'utf8'));
    if (intent?.target_pid !== targetPid) return null;
    if (!(now() - Date.parse(intent.at) <= INTENT_TTL_MS)) return null;
    return { reason: String(intent.reason), by: intent.by ?? null, at: intent.at };
  } catch { return null; }
}

export async function clearShutdownIntent({ directory = STATE_DIR } = {}) {
  try { await fs.unlink(fileFor(directory)); } catch { /* absent */ }
}
