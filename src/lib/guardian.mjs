import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { readState, readPidFile, readHandshake } from './state.mjs';
import { probeDaemon } from './control.mjs';
import { clearPacRouting } from './pac.mjs';
import { acquireRuntime } from './runtime.mjs';
import { recordRuntimeEvent } from './runtime-identity.mjs';
import { writeShutdownIntent } from './shutdown-intent.mjs';
import { logLine, errorFields } from './log-line.mjs';
import { STATE_DIR } from './config.mjs';

const exec = promisify(execFile);
const alive = (pid) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
};
const coreCount = () => os.cpus().length;
export const healthTimeoutPolicy = ({ failingForMs, unhealthyMs }) => failingForMs >= unhealthyMs;

// Three outcomes distinguish an exited process from a live, unrelated owner.
export async function verifyOwnedDaemon(pid, { readPid = readPidFile, state = readState, run = exec,
  loadavg = os.loadavg, cores = coreCount,
} = {}) {
  const current = await state();
  if (await readPid() !== pid || current?.pid !== pid || current.runtime_role !== 'daemon') return 'unverified';
  const expected = current.runtime_entry;
  if (typeof expected !== 'string' || !expected.startsWith(path.join(STATE_DIR, 'runtime', 'build-')) || !expected.endsWith('/src/server.mjs')) return 'unverified';
  const timeout = Math.min(10000, Math.ceil(2000 * Math.max(1, loadavg()[0] / Math.max(1, cores()))));
  let stdout;
  try { ({ stdout } = await run('/bin/ps', ['-p', String(pid), '-o', 'args='], { timeout, maxBuffer: 16384 })); }
  catch (error) {
    if (error.killed || error.signal) {
      throw Object.assign(new Error(error.message, { cause: error }), { code: 'GUARDIAN_VERIFY_TIMEOUT', signal: error.signal, killed: error.killed });
    }
    if (error.code === 1) return 'gone';
    throw error;
  }
  if (!stdout.trim()) return 'gone';
  return /(?:^|\s)\S*node(?:\s|$)/.test(stdout) && stdout.includes(`${expected} --daemon`) ? 'owned' : 'unverified';
}

// Single-shot helper: escalation belongs to createGuardian's state across ticks.
export async function terminateOwnedDaemon(pid, { signal = process.kill.bind(process), ...deps } = {}) {
  if (await verifyOwnedDaemon(pid, deps) !== 'owned') return false;
  try { await signal(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  return true;
}

export function createGuardian({ read = readState, readPid = readPidFile, handshake = readHandshake,
  probe = probeDaemon, isAlive = alive, acquire = acquireRuntime, restore = clearPacRouting,
  run = exec, signal = process.kill.bind(process), intent = writeShutdownIntent,
  record = recordRuntimeEvent, log = logLine, now = Date.now, loadavg = os.loadavg, cores = coreCount,
  unhealthyMs = 30000, killAfterMs = 25000, shouldTerminate = healthTimeoutPolicy,
} = {}) {
  let failingPid = null, failureSince = null, termination = null;
  const lastFailureEvent = new Map();
  const resetFailure = () => { failingPid = null; failureSince = null; };
  const reportFailure = async (step, error, started) => {
    const details = { step, ...errorFields(error), elapsed_ms: now() - started, load1: loadavg()[0] };
    log('guardian', 'step failed', details);
    if (!lastFailureEvent.has(step) || now() - lastFailureEvent.get(step) >= 60000) {
      lastFailureEvent.set(step, now());
      try { await record('guardian_step_failed', { source: 'guardian', details }); }
      catch (recordError) {
        // Do not recursively try to journal a journal failure.
        log('guardian', 'step failed', { step: 'record', ...errorFields(recordError), elapsed_ms: now() - started, load1: details.load1 });
      }
    }
  };
  const step = async (name, fn) => {
    const started = now();
    try { return await fn(); }
    catch (error) { await reportFailure(name, error, started); throw Object.assign(new Error(`Guardian step failed: ${name}`, { cause: error }), { guardianStep: name }); }
  };
  const event = (name, pid, details) => step('record', () => record(name, { source: 'guardian', pid, reason: 'health_timeout', details }));
  const verify = (pid) => step('verify', () => verifyOwnedDaemon(pid, { readPid, state: read, run, loadavg, cores }));
  const send = (pid, sig) => step('signal', async () => {
    try { await signal(pid, sig); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  });
  const exited = async () => {
    termination.gone = true;
    await event('restarted_unresponsive_owner', termination.pid, { exit_wait_ms: now() - termination.sigtermAt });
    termination = null; resetFailure();
    return { action: 'owner_exited' };
  };
  return async () => {
    try {
      // Finish pending termination even if shutdown cleared state or a new owner started.
      if (termination) {
        if (termination.killEventPending) {
          await event('killed_unresponsive_owner', termination.pid, { exit_wait_ms: now() - termination.sigtermAt });
          termination.killEventPending = false;
        }
        if (termination.gone || !await step('is_alive', () => isAlive(termination.pid))) return await exited();
        if (now() - termination.sigtermAt < killAfterMs) return { action: 'waiting_for_exit' };
        const ownership = await verify(termination.pid);
        if (ownership === 'gone') return await exited();
        if (ownership !== 'owned') {
          termination = null; resetFailure();
          return { action: 'unverified_owner_preserved' };
        }
        if (termination.killed) return { action: 'waiting_for_exit' };
        if (!await send(termination.pid, 'SIGKILL')) { termination.gone = true; return await exited(); }
        termination.killed = true; termination.killEventPending = true;
        await event('killed_unresponsive_owner', termination.pid, { exit_wait_ms: now() - termination.sigtermAt });
        termination.killEventPending = false;
        return { action: 'kill_requested' };
      }
      const state = await step('read', read);
      if (!state?.pid || state.runtime_role !== 'daemon') { resetFailure(); return { action: 'idle' }; }
      if (!await step('is_alive', () => isAlive(state.pid))) {
        let release;
        const acquired = await step('acquire', async () => {
          try { release = await acquire({ wait: false }); return true; }
          catch (error) { if (error.code === 'RUNTIME_BUSY') return false; throw error; }
        });
        if (!acquired) return { action: 'waiting_for_owner' };
        try {
          const current = await step('read', read);
          if (current?.pid !== state.pid || await step('is_alive', () => isAlive(state.pid))) return { action: 'owner_changed' };
          if (current.routing_active) {
            await step('restore', () => restore({ recoverStale: true }));
            await step('record', () => record('restored_dead_owner_routing', { source: 'guardian', pid: state.pid }));
          }
          resetFailure(); return { action: 'dead_owner_recovered' };
        } finally { await step('release', release); }
      }
      if (await step('read_pid', readPid) !== state.pid) { resetFailure(); return { action: 'startup_in_progress' }; }
      const auth = await step('handshake', handshake);
      if (auth && await step('probe', () => probe(auth.controlUrl, auth.token, 1000))) {
        resetFailure(); return { action: 'healthy' };
      }
      if (failingPid !== state.pid) { failingPid = state.pid; failureSince = now(); }
      const failingForMs = now() - failureSince;
      if (!await step('decision', () => shouldTerminate({ failingForMs, unhealthyMs, state }))) return { action: 'waiting_for_health' };
      const ownership = await verify(state.pid);
      if (ownership === 'unverified') return { action: 'unverified_owner_preserved' };
      if (ownership === 'gone') {
        termination = { pid: state.pid, sigtermAt: now(), gone: true };
        return await exited();
      }
      await step('intent', () => intent({ targetPid: state.pid, reason: 'guardian_health_timeout', by: 'guardian' }));
      await event('terminating_unresponsive_owner', state.pid, { failing_for_ms: failingForMs, load1: loadavg()[0], cores: cores(), probe_timeout_ms: 1000 });
      const sent = await send(state.pid, 'SIGTERM');
      termination = { pid: state.pid, sigtermAt: now(), gone: !sent };
      if (!sent) return await exited();
      return { action: 'restart_requested' };
    } catch (error) {
      if (error?.guardianStep) return { action: 'step_failed', step: error.guardianStep };
      await reportFailure('tick', error, now());
      return { action: 'step_failed', step: 'tick' };
    }
  };
}
