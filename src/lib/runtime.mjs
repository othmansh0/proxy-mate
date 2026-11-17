import { readEnvironment } from './environment.mjs';
import lockfile from 'proper-lockfile';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { STATE_DIR } from './config.mjs';
import { readState, isStateStale, defensiveNetworkResetAllServices, clearState } from './state.mjs';
import { recordRuntimeEvent } from './runtime-identity.mjs';
import { readShutdownIntent, clearShutdownIntent } from './shutdown-intent.mjs';
import { logLine, errorFields } from './log-line.mjs';
let registeredShutdown;
let pendingCompromise = false;
function compromisedShutdown(...args) {
  if (registeredShutdown) return registeredShutdown(...args);
  pendingCompromise = true;
}

// One process owns a state directory, even when clients choose different ports.
// Heartbeats make recovery after SIGKILL possible without trusting a PID file.
export async function acquireRuntime({ directory = STATE_DIR, wait = true, lock = lockfile.lock, recordEvent = recordRuntimeEvent, shutdown = compromisedShutdown } = {}) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    return await lock(path.join(directory, 'runtime'), {
      onCompromised: (error) => {
        void Promise.resolve().then(() => recordEvent('runtime_lock_compromised', {
          reason: 'lock_compromised', code: 1, details: errorFields(error),
        })).catch(() => {});
        void shutdown(1, 'lock_compromised');
      },
      realpath: false, stale: 10_000, update: 2_000,
      retries: wait ? { retries: 12, minTimeout: 1_000, maxTimeout: 1_000, factor: 1 } : 0,
    });
  } catch (cause) {
    if (cause.code !== 'ELOCKED') throw cause;
    throw Object.assign(new Error('Another proxy-mate process owns this state directory. Use the shared daemon or a separate PROXY_MATE_HOME.'), {
      code: 'RUNTIME_BUSY', retryable: true,
    });
  }
}

export async function reconcileRuntime(options = {}) {
  const state = await readState();
  const stale = await isStateStale(options);
  // Includes pre-lock releases of proxy-mate: never take over their live state.
  if (state?.pid && state.pid !== process.pid && !stale) {
    throw Object.assign(new Error('A live proxy-mate process owns the recorded state. Stop that process before starting a new runtime.'), {
      code: 'RUNTIME_BUSY', retryable: true,
    });
  }
  if (stale) {
    const reset = await defensiveNetworkResetAllServices();
    if (reset.failed?.length) {
      throw Object.assign(new Error('Could not restore routing from the previous runtime. Recovery state has been retained.'), {
        code: 'ROUTING_RECOVERY_FAILED', details: reset,
      });
    }
    await clearState();
  }
}

// Register before startup. Cleanup waits for startup to settle, so a signal
// during a slow certificate operation cannot race new listeners into existence.
export function installShutdownHandlers(cleanup, { stdin = false, timeoutMs = 20_000,
  eventTimeoutMs = 1000, process: proc = process, recordEvent = recordRuntimeEvent,
  readIntent = readShutdownIntent, clearIntent = clearShutdownIntent } = {}) {
  let stopping = null;
  let pressureSamples = 0;
  const configuredRss = Number(readEnvironment('PROXY_MATE_MAX_RSS_MB') ?? 1024);
  const maxRss = Number.isFinite(configuredRss) && configuredRss >= 128 ? configuredRss * 1024 * 1024 : 1024 * 1024 * 1024;
  const memoryTimer = setInterval(() => {
    pressureSamples = proc.memoryUsage().rss > maxRss ? pressureSamples + 1 : 0;
    if (pressureSamples >= 3) {
      process.stderr.write('[proxy-mate] sustained memory pressure: draining and restoring routing before exit; launchd will restart the daemon\n');
      void shutdown(1, 'memory_pressure');
    }
  }, 2000);
  memoryTimer.unref();
  const writes = [];
  const record = (event, data) => {
    const write = Promise.resolve().then(() => recordEvent(event, data)).catch(() => {});
    writes.push(write);
    return write;
  };
  const shutdown = (code = 0, reason = 'requested_shutdown') => {
    if (stopping) return stopping;
    const started = performance.now();
    clearInterval(memoryTimer);
    const timer = setTimeout(() => {
      logLine('runtime', 'shutdown deadline exceeded; recovery state retained', { elapsed_ms: Math.round(performance.now() - started) });
      proc.exit(1);
    }, timeoutMs);
    record('stopping', { reason, code });
    // Start cleanup independently of journal I/O; bound the final journal flush.
    stopping = Promise.resolve().then(cleanup).then(() => code, (error) => {
      logLine('runtime', 'cleanup failed', errorFields(error));
      return 1;
    }).then(async (exitCode) => {
      let flushTimer;
      const flush = async () => {
        let seen = 0;
        while (seen < writes.length) {
          const batch = writes.slice(seen);
          seen = writes.length;
          await Promise.all(batch);
        }
      };
      await Promise.race([flush(), new Promise(resolve => { flushTimer = setTimeout(resolve, eventTimeoutMs); })]);
      clearTimeout(flushTimer);
      clearTimeout(timer);
      proc.exit(exitCode);
    });
    return stopping;
  };
  proc.once('SIGTERM', () => {
    void (async () => {
      let intent;
      try { intent = await readIntent(proc.pid); } catch { /* fallback */ }
      try { await clearIntent(); } catch { /* best effort */ }
      await shutdown(0, intent?.reason || 'signal_sigterm');
    })();
  });
  proc.once('SIGINT', () => void shutdown(0, 'signal_sigint'));
  const fatal = (error) => {
    logLine('runtime', 'fatal', errorFields(error));
    record('fatal_error', { reason: stopping ? 'fatal_while_stopping' : 'fatal_error', code: 1, details: errorFields(error) });
    void shutdown(1, 'fatal_error');
  };
  proc.on('uncaughtException', fatal);
  proc.on('unhandledRejection', fatal);
  if (stdin) {
    proc.stdin.once('end', () => void shutdown());
    proc.stdin.once('close', () => void shutdown());
    proc.stdout.on('error', (error) => error.code === 'EPIPE' ? void shutdown() : fatal(error));
  }
  registeredShutdown = shutdown;
  if (pendingCompromise) { pendingCompromise = false; queueMicrotask(() => void shutdown(1, 'lock_compromised')); }
  return shutdown;
}
