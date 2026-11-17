import test from 'node:test';
import assert from 'node:assert/strict';
import { startGuardian } from '../src/guardian.mjs';
import { logLine } from '../src/lib/log-line.mjs';

function entry(tick) {
  let interval, deadline;
  const lines = [], exits = [], handlers = {};
  const controller = startGuardian({ tick,
    log: (component, message, fields) => logLine(component, message, fields, { write: line => lines.push(line) }),
    interval: fn => { interval = fn; return 1; }, clear: () => {},
    timeout: fn => { deadline = fn; return 2; }, clearTimeout: () => {},
    exit: code => exits.push(code), once: (sig, fn) => { handlers[sig] = fn; },
  });
  return { controller, lines, exits, handlers, run: () => interval(), deadline: () => deadline() };
}

test('guardian entry logs startup and unexpected errors with timestamp, step and message', async () => {
  const f = entry(async () => { throw Object.assign(new Error('unexpected read failure'), { code: null }); });
  await f.run();
  assert.match(f.lines[0], /^\d{4}-\d\d-\d\dT.* guardian pid=\d+\] started/);
  assert.match(f.lines[1], /step=tick/);
  assert.match(f.lines[1], /error_message="unexpected read failure"/);
  await f.controller.stop();
});

test('guardian entry skips busy ticks and stops after the current tick', async () => {
  let resolve, calls = 0;
  const f = entry(() => { calls++; return new Promise(r => { resolve = r; }); });
  const running = f.run(); await f.run(); assert.equal(calls, 1);
  const stopping = f.handlers.SIGTERM(); assert.deepEqual(f.exits, []);
  await f.run(); assert.equal(calls, 1);
  resolve(); await running; await stopping;
  assert.deepEqual(f.exits, [0]);
});

test('guardian entry bounds waiting for a stuck tick on SIGINT', async () => {
  const f = entry(() => new Promise(() => {})); f.run(); await Promise.resolve();
  f.handlers.SIGINT(); f.deadline();
  assert.deepEqual(f.exits, [1]);
  assert.match(f.lines.at(-1), /stop deadline exceeded/);
});
