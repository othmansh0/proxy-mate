#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { createGuardian } from './lib/guardian.mjs';
import { logLine, errorFields } from './lib/log-line.mjs';
import os from 'node:os';

export function startGuardian({ tick = createGuardian(), log = logLine,
  interval = setInterval, clear = clearInterval, timeout = setTimeout, clearTimeout: cancelTimeout = clearTimeout,
  exit = process.exit.bind(process), once = process.once.bind(process), now = Date.now,
  loadavg = os.loadavg, stopWaitMs = 10000,
} = {}) {
  let busy = false, stopping = false, current = Promise.resolve(), stopped;
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
      cancelTimeout(deadline);
      log('guardian', 'stopped');
      exit(0);
    })();
    return stopped;
  };
  once('SIGTERM', stop);
  once('SIGINT', stop);
  return { stop };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startGuardian();
