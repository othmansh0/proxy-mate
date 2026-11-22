#!/usr/bin/env node
import { readEnvironment } from './lib/environment.mjs';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { createGuardian } from './lib/guardian.mjs';
import { logLine, errorFields } from './lib/log-line.mjs';
import os from 'node:os';
import { createPacHost } from './lib/pac-host.mjs';

export function startGuardian({ tick = createGuardian(), log = logLine,
  interval = setInterval, clear = clearInterval, timeout = setTimeout, clearTimeout: cancelTimeout = clearTimeout,
  exit = process.exit.bind(process), once = process.once.bind(process), now = Date.now,
  loadavg = os.loadavg, stopWaitMs = 10000,
  env = process.env, pacHostOptions = {}, pacHostFactory = createPacHost,
} = {}) {
  let busy = false, stopping = false, current = Promise.resolve(), stopped;
  let pacHost;
  const ready = Promise.resolve().then(async () => {
    if (readEnvironment('PROXYFAN_PAC_HOST', env) !== 'guardian') return;
    try {
      pacHost = pacHostFactory({ ...pacHostOptions, port: Number(readEnvironment('PROXYFAN_PAC_PORT', env) ?? 8081) });
      await pacHost.start();
      log('guardian', 'PAC host started', { port: pacHost.port });
    } catch (error) {
      log('guardian', 'PAC host unavailable', errorFields(error));
    }
  });
  log('guardian', 'started', { tick_ms: 3000, stop_wait_ms: stopWaitMs });
  const timer = interval(() => {
    if (busy || stopping) return;
    busy = true;
    const started = now();
    current = Promise.resolve().then(tick).catch((error) => {
      log('guardian', 'step failed', { step: 'tick', ...errorFields(error), elapsed_ms: now() - started, load1: loadavg()[0] });
    }).finally(() => { busy = false; });
    return current;
  }, 3000);
  const stop = () => {
    if (stopping) return stopped;
    stopping = true;
    clear(timer);
    stopped = (async () => {
      const deadline = timeout(() => {
        log('guardian', 'stop deadline exceeded', { wait_ms: stopWaitMs });
        exit(1);
      }, stopWaitMs);
      await current;
      await ready;
      await pacHost?.stop();
      cancelTimeout(deadline);
      log('guardian', 'stopped');
      exit(0);
    })();
    return stopped;
  };
  once('SIGTERM', stop);
  once('SIGINT', stop);
  return { stop, ready };
}

// Node resolves symlinks for the main module, so compare real paths: a
// guardian launched through a symlinked runtime path must still start.
const invokedDirectly = () => {
  if (!process.argv[1]) return false;
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return import.meta.url === pathToFileURL(process.argv[1]).href; }
};
if (invokedDirectly()) startGuardian();
