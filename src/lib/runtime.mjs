import { readEnvironment } from './environment.mjs';
import lockfile from 'proper-lockfile';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { STATE_DIR } from './config.mjs';
import { readState, isStateStale, defensiveNetworkResetAllServices, clearState } from './state.mjs';
import { recordRuntimeEvent } from './runtime-identity.mjs';

// One process owns a state directory, even when clients choose different ports.
// Heartbeats make recovery after SIGKILL possible without trusting a PID file.
export async function acquireRuntime({ directory = STATE_DIR, wait = true } = {}) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    return await lockfile.lock(path.join(directory, 'runtime'), {
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

export async function reconcileRuntime() {
  const state = await readState();
  // Includes pre-lock releases of proxy-mate: never take over their live state.
  if (state?.pid && state.pid !== process.pid && !await isStateStale()) {
    throw Object.assign(new Error('A live proxy-mate process owns the recorded state. Stop that process before starting a new runtime.'), {
      code: 'RUNTIME_BUSY', retryable: true,
    });
  }
  if (await isStateStale()) {
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
export function installShutdownHandlers(cleanup, { stdin = false, timeoutMs = 18_000 } = {}) {
  let stopping = null;
  let pressureSamples = 0;
  const configuredRss = Number(readEnvironment('PROXY_MATE_MAX_RSS_MB') ?? 1024);
  const maxRss = Number.isFinite(configuredRss) && configuredRss >= 128 ? configuredRss * 1024 * 1024 : 1024 * 1024 * 1024;
  const memoryTimer = setInterval(() => {
    pressureSamples = process.memoryUsage().rss > maxRss ? pressureSamples + 1 : 0;
    if (pressureSamples >= 3) {
      process.stderr.write('[proxy-mate] sustained memory pressure: draining and restoring routing before exit; launchd will restart the daemon\n');
      void shutdown(1, 'memory_pressure');
    }
  }, 2000);
  memoryTimer.unref();
  const shutdown = (code = 0, reason = 'requested_shutdown') => {
    if (stopping) return stopping;
    clearInterval(memoryTimer);
    const timer = setTimeout(() => {
      process.stderr.write('[proxy-mate] shutdown deadline exceeded; recovery state retained\n');
      process.exit(1);
    }, timeoutMs);
    stopping = recordRuntimeEvent('stopping', { reason, code }).catch(() => {}).then(cleanup).then(
      () => { clearTimeout(timer); process.exit(code); },
      (error) => {
        process.stderr.write(`[proxy-mate] cleanup failed: ${error?.message ?? error}\n`);
        clearTimeout(timer); process.exit(1);
      },
    );
    return stopping;
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
  const fatal = (error) => {
    process.stderr.write(`[proxy-mate] fatal: ${error?.message ?? error}\n`);
    void shutdown(1, 'fatal_error');
  };
  process.once('uncaughtException', fatal);
  process.once('unhandledRejection', fatal);
  if (stdin) {
    process.stdin.once('end', () => void shutdown());
    process.stdin.once('close', () => void shutdown());
    process.stdout.on('error', (error) => error.code === 'EPIPE' ? void shutdown() : fatal(error));
  }
  return shutdown;
}
