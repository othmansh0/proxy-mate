import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_VERSION, STATE_DIR } from './config.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);

const root = fileURLToPath(new URL('../../', import.meta.url));
export async function runtimeIdentity() {
  let marker = null;
  try { marker = JSON.parse(await fs.readFile(path.join(root, '.proxy-runtime.json'), 'utf8')); } catch { /* checkout */ }
  return { version: SERVER_VERSION, node: process.version, node_executable: process.execPath,
    entry_root: root, installed: ['proxyfan', 'proxy-mate', 'proxy-mcp'].includes(marker?.managed_by),
    content_sha256: marker?.content_sha256 ?? null, dependency_lock_sha256: marker?.dependency_lock_sha256 ?? null,
    staged_at: marker?.staged_at ?? null };
}

export async function readRuntimeEvents(source = 'daemon') {
  const events = [];
  try {
    const legacy = JSON.parse(await fs.readFile(path.join(STATE_DIR, `${source}.events.json`), 'utf8'));
    if (Array.isArray(legacy)) events.push(...legacy.filter(isEvent));
  } catch { /* legacy is read-only and may be corrupt */ }
  for (const suffix of ['.1', '']) {
    try {
      const text = await fs.readFile(path.join(STATE_DIR, `${source}.events.jsonl${suffix}`), 'utf8');
      for (const line of text.split('\n')) {
        try { const event = JSON.parse(line); if (isEvent(event)) events.push(event); }
        catch { /* retain valid history around an interrupted append */ }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return events.slice(-64);
}

function isEvent(value) { return value && typeof value === 'object' && typeof value.event === 'string'; }

// Never interrogate launchd for an unsupervised process (including test runs).
export async function readLaunchdLastExit({ run = execFileP } = {}) {
  try {
    const { stdout } = await run('/bin/launchctl', ['list', 'dev.proxyfan.daemon'], { timeout: 2000 });
    const match = stdout.match(/"LastExitStatus"\s*=\s*(-?\d+)/);
    return match ? Number(match[1]) : null;
  } catch { return null; }
}

export async function recordPreviousExit({ pid = process.pid, serviceName = process.env.XPC_SERVICE_NAME,
  readEvents = readRuntimeEvents, recordEvent = recordRuntimeEvent, readLastExit = readLaunchdLastExit } = {}) {
  const events = await readEvents('daemon');
  const readyIndex = events.findLastIndex(e => e.event === 'ready');
  const previous = events[readyIndex];
  if (!previous || previous.pid === pid || events.slice(readyIndex + 1).some(e =>
    e.pid === previous.pid && ['stopping', 'startup_failed'].includes(e.event))) return;
  const launchd_last_exit = serviceName === 'dev.proxyfan.daemon' ? await readLastExit() : null;
  await recordEvent('previous_exit_unrecorded', { details: { previous_pid: previous.pid, launchd_last_exit } });
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
    const file = path.join(STATE_DIR, `${source}.events.jsonl`);
    await fs.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
    try {
      if ((await fs.stat(file)).size > 256 * 1024) await fs.rename(file, `${file}.1`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const entry = { event, reason, code, pid, node: process.version, at: new Date().toISOString(), ...eventDetails(details) };
    await fs.appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600, flag: 'a' });
  });
  mutation = operation.catch(() => {});
  return operation;
}
