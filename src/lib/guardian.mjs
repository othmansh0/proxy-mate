import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { readState, readPidFile, readHandshake } from './state.mjs';
import { probeDaemon } from './control.mjs';
import { clearPacRouting } from './pac.mjs';
import { acquireRuntime } from './runtime.mjs';
import { recordRuntimeEvent } from './runtime-identity.mjs';
import { STATE_DIR } from './config.mjs';

const exec = promisify(execFile);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function terminateOwnedDaemon(pid, { readPid = readPidFile, state = readState, run = exec,
  signal = process.kill.bind(process), isAlive = alive, sleep = delay,
} = {}) {
  const verified = async () => {
    const current = await state();
    if (await readPid() !== pid || current?.pid !== pid || current.runtime_role !== 'daemon') return false;
    const expected = current.runtime_entry;
    if (typeof expected !== 'string' || !expected.startsWith(path.join(STATE_DIR, 'runtime', 'build-')) || !expected.endsWith('/src/server.mjs')) return false;
    const { stdout } = await run('/bin/ps', ['-p', String(pid), '-o', 'args='], { timeout: 2000, maxBuffer: 16384 });
    return /(?:^|\s)\S*node(?:\s|$)/.test(stdout) && stdout.includes(`${expected} --daemon`);
  };
  if (!await verified()) return false;
  try { signal(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  for (let i = 0; i < 25 && isAlive(pid); i++) await sleep(200);
  if (isAlive(pid) && await verified()) signal(pid, 'SIGKILL');
  return true;
}

export function createGuardian({ read = readState, readPid = readPidFile, handshake = readHandshake,
  probe = probeDaemon, isAlive = alive, acquire = acquireRuntime, restore = clearPacRouting,
  terminate = terminateOwnedDaemon, record = recordRuntimeEvent, now = Date.now,
  unhealthyMs = 30000,
} = {}) {
  let failingPid = null, failureSince = null;
  return async () => {
    const state = await read();
    if (!state?.pid || state.runtime_role !== 'daemon') return { action: 'idle' };
    if (!isAlive(state.pid)) {
      let release;
      try { release = await acquire({ wait: false }); }
      catch (error) { if (error.code === 'RUNTIME_BUSY') return { action: 'waiting_for_owner' }; throw error; }
      try {
        const current = await read();
        if (current?.pid !== state.pid || isAlive(state.pid)) return { action: 'owner_changed' };
        if (current.routing_active) {
          await restore({ recoverStale: true });
          await record('restored_dead_owner_routing', { source: 'guardian', pid: state.pid });
        }
        return { action: 'dead_owner_recovered' };
      } finally { await release(); }
    }
    if (await readPid() !== state.pid) return { action: 'startup_in_progress' };
    const auth = await handshake();
    if (auth && await probe(auth.controlUrl, auth.token, 1000)) {
      failingPid = null; failureSince = null;
      return { action: 'healthy' };
    }
    if (failingPid !== state.pid) { failingPid = state.pid; failureSince = now(); }
    if (now() - failureSince < unhealthyMs) return { action: 'waiting_for_health' };
    const stopped = await terminate(state.pid);
    if (stopped) await record('restarted_unresponsive_owner', { source: 'guardian', pid: state.pid, reason: 'health_timeout' });
    failingPid = null; failureSince = null;
    return { action: stopped ? 'restart_requested' : 'unverified_owner_preserved' };
  };
}
