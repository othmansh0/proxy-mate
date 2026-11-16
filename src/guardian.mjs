#!/usr/bin/env node
import { createGuardian } from './lib/guardian.mjs';
const tick = createGuardian();
let busy = false;
let current = Promise.resolve();
const timer = setInterval(() => {
  if (busy) return;
  busy = true;
  current = tick().catch((error) => { process.stderr.write(`[proxy-mate guardian] recovery check failed: ${error.code ?? error.name}\n`); })
    .finally(() => { busy = false; });
}, 3000);
const stop = async () => {
  clearInterval(timer);
  setTimeout(() => process.exit(1), 10000);
  await current;
  process.exit(0);
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
