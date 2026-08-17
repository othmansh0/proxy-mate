// state.json — persisted daemon state for crash recovery.
//
// Pattern (per Agent D's research): SIGKILL/OOM never fires user code. The
// robust recovery story is "state on disk before mutation, reconcile on next
// boot." We write the file BEFORE touching networksetup so a hard kill leaves
// breadcrumbs for the next startup to clean up.

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { STATE_DIR } from './config.mjs';

const execFileP = promisify(execFile);
const NETWORKSETUP = '/usr/sbin/networksetup';
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const PID_FILE = path.join(STATE_DIR, 'daemon.pid');
const HANDSHAKE_FILE = path.join(STATE_DIR, 'handshake.json');
let stateMutation = Promise.resolve();

export { STATE_DIR, STATE_FILE, PID_FILE, HANDSHAKE_FILE };

export async function readState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export async function writeState(state) {
  await atomicWriteJson(STATE_FILE, state, 0o600);
}

export async function patchState(partial) {
  const operation = stateMutation.then(async () => {
    const current = (await readState()) ?? {};
    const next = { ...current, ...partial };
    await writeState(next);
    return next;
  });
  stateMutation = operation.catch(() => {});
  return operation;
}

export async function clearState() {
  try { await fs.unlink(STATE_FILE); } catch { /* ignore */ }
}

// True if state.json points at a process that no longer exists or no longer
// holds either of the recorded ports.
export async function isStateStale() {
  const state = await readState();
  if (!state) return false;
  if (state.pid) {
    if (!processAlive(state.pid)) return true;
  }
  return false;
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; } // EPERM means it exists but we can't signal it
}

// PID file management (separate from state.json so external tools can scan it
// without parsing JSON).
export async function writePidFile(pid) {
  await atomicWriteFile(PID_FILE, `${pid}\n`, 0o600);
}

export async function readPidFile() {
  try {
    const raw = await fs.readFile(PID_FILE, 'utf8');
    const pid = parseInt(raw.trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch { return null; }
}

export async function clearPidFile() {
  try { await fs.unlink(PID_FILE); } catch { /* ignore */ }
}

// Handshake auth file — written 0600 so only the user (and processes they
// spawn) can read it. Used by client-mode MCP servers to authenticate against
// the daemon's control plane.
export async function writeHandshake(token, controlUrl, scopes = ['observe', 'control']) {
  await atomicWriteJson(HANDSHAKE_FILE, {
    token, controlUrl, scopes, written_at: new Date().toISOString(),
  }, 0o600);
}

export async function readHandshake() {
  try {
    return JSON.parse(await fs.readFile(HANDSHAKE_FILE, 'utf8'));
  } catch { return null; }
}

export async function clearHandshake() {
  try { await fs.unlink(HANDSHAKE_FILE); } catch { /* ignore */ }
}

// Crash recovery must only undo the exact automatic proxy setting that this
// process recorded. Disabling every proxy type on every network service can
// destroy VPN/corporate/user configuration unrelated to proxy-mcp.
export async function defensiveNetworkResetAllServices() {
  const state = await readState();
  const service = state?.network_service;
  if (!service || !state?.routing_active) {
    return { reset: [], skipped: 'no recorded proxy-mcp routing mutation' };
  }
  try {
    if (state?.prior_auto_proxy?.enabled && state.prior_auto_proxy.url) {
      await execFileP(NETWORKSETUP, ['-setautoproxyurl', service, state.prior_auto_proxy.url], commandOptions());
      await execFileP(NETWORKSETUP, ['-setautoproxystate', service, 'on'], commandOptions());
    } else {
      await execFileP(NETWORKSETUP, ['-setautoproxystate', service, 'off'], commandOptions());
      await execFileP(NETWORKSETUP, ['-setautoproxyurl', service, ''], commandOptions());
    }
    return { reset: [service] };
  } catch (error) {
    return { reset: [], failed: [{ service, error: error?.message ?? String(error) }] };
  }
}

// Targeted reset: clear only the autoproxy on the service we configured.
export async function targetedAutoProxyOff(service) {
  if (!service) return false;
  try { await execFileP(NETWORKSETUP, ['-setautoproxystate', service, 'off']); }
  catch { /* ignore */ }
  return true;
}

export async function atomicWriteJson(filePath, value, mode = 0o600) {
  return atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export async function atomicWriteFile(filePath, value, mode = 0o600) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    await fs.writeFile(temp, value, { mode, flag: 'wx' });
    await fs.rename(temp, filePath);
    await fs.chmod(filePath, mode);
  } finally {
    try { await fs.unlink(temp); } catch { /* renamed or never created */ }
  }
}

function commandOptions() {
  return { timeout: 10_000, maxBuffer: 1024 * 1024 };
}
