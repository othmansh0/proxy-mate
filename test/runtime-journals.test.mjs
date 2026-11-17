import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-journals-'));
process.env.PROXY_MATE_HOME = home;
const identity = await import('../src/lib/runtime-identity.mjs');
const state = await import('../src/lib/state.mjs');
const runtime = await import('../src/lib/runtime.mjs');
after(() => fs.rm(home, { recursive: true, force: true }));

test('journal appends in order, merges legacy and rotated events, tolerates corrupt lines', async () => {
  await fs.writeFile(path.join(home, 'daemon.events.json'), JSON.stringify([{ event: 'legacy' }]));
  await fs.writeFile(path.join(home, 'daemon.events.jsonl'), '{bad\n');
  await Promise.all(Array.from({ length: 70 }, (_, i) => identity.recordRuntimeEvent(`event_${i}`)));
  const events = await identity.readRuntimeEvents();
  assert.equal(events.length, 64);
  assert.equal(events[0].event, 'event_6');
  assert.equal(events.at(-1).event, 'event_69');
  const raw = await fs.readFile(path.join(home, 'daemon.events.jsonl'), 'utf8');
  assert.ok(raw.startsWith('{bad\n'));
  await fs.appendFile(path.join(home, 'daemon.events.jsonl'), 'x'.repeat(256 * 1024) + '\n');
  await identity.recordRuntimeEvent('rotated');
  assert.equal((await identity.readRuntimeEvents()).at(-2).event, 'event_69');
  assert.equal((await identity.readRuntimeEvents()).at(-1).event, 'rotated');
  assert.ok((await fs.stat(path.join(home, 'daemon.events.jsonl.1'))).size > 256 * 1024);
  await fs.writeFile(path.join(home, 'guardian.events.json'), '[{"event":"legacy"}]');
  await identity.recordRuntimeEvent('new', { source: 'guardian' });
  assert.deepEqual((await identity.readRuntimeEvents('guardian')).map(e => e.event), ['legacy', 'new']);
});

test('temp sweep only removes old regular files belonging to dead pids', async () => {
  const dir = await fs.mkdtemp(path.join(home, 'sweep-'));
  for (const name of ['.state.json.12.abcdef.tmp', '.state.json.13.abcdef.tmp', '.state.json.14.abcdef.tmp', 'other.tmp']) {
    await fs.writeFile(path.join(dir, name), '');
    await fs.utimes(path.join(dir, name), new Date(0), new Date(name.includes('.14.') ? 99000 : 0));
  }
  assert.deepEqual(await state.sweepStaleTempFiles(dir, { isAlive: pid => pid === 13, now: () => 100000 }), ['.state.json.12.abcdef.tmp']);
});

test('owner identity checks boot and process start time with injectable runners', async () => {
  const owner = { pid: 12, boot_session: 'boot', pid_started_at: 'start' };
  const readers = { isAlive: () => true, readStartTime: async () => 'start', readBootSession: async () => 'boot' };
  assert.equal(await state.isRecordedOwnerAlive(owner, readers), true);
  assert.equal(await state.isRecordedOwnerAlive(owner, { ...readers, readBootSession: async () => 'other' }), false);
  assert.equal(await state.isRecordedOwnerAlive(owner, { ...readers, readStartTime: async () => 'other' }), false);
  await state.writeState(owner);
  assert.equal(await state.isStateStale({ ...readers, readStartTime: async () => 'other' }), true);
  const run = async (cmd, args) => ({ stdout: cmd.endsWith('ps') ? ' start \n' : ' boot\n' });
  assert.deepEqual(await state.readProcessIdentity(12, { run }), { boot_session: 'boot', pid_started_at: 'start' });
});

function fakeProcess() {
  return Object.assign(new EventEmitter(), { pid: 42, memoryUsage: () => ({ rss: 0 }), exit(code) { this.exited = code; } });
}
test('SIGTERM consumes intent and cleanup runs while the event write is pending', async () => {
  const proc = fakeProcess(); let cleared = false, cleaned = false, finish;
  const events = [];
  const shutdown = runtime.installShutdownHandlers(async () => { cleaned = true; }, {
    process: proc, readIntent: async () => ({ reason: 'guardian_health_timeout' }), clearIntent: async () => { cleared = true; },
    recordEvent: (event, data) => { events.push({ event, ...data }); return new Promise(resolve => { finish = resolve; }); },
  });
  proc.emit('SIGTERM');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cleaned, true); assert.equal(cleared, true);
  assert.equal(events[0].reason, 'guardian_health_timeout');
  finish(); await shutdown(); assert.equal(proc.exited, 0);
});
test('second fatal error is recorded while cleanup is pending', async () => {
  const proc = fakeProcess(); const events = []; let finish;
  const shutdown = runtime.installShutdownHandlers(() => new Promise(resolve => { finish = resolve; }), {
    process: proc, recordEvent: async (event, data) => { events.push({ event, ...data }); },
  });
  proc.emit('uncaughtException', new Error('first'));
  await new Promise(resolve => setImmediate(resolve));
  proc.emit('uncaughtException', new Error('second'));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(events.some(e => e.event === 'fatal_error' && e.details.error_message === 'second'));
  finish(); await shutdown(); assert.equal(proc.exited, 1);
});
test('compromised locks record attribution and request clean shutdown', async () => {
  const events = [], exits = [];
  await runtime.acquireRuntime({ directory: path.join(home, 'lock'), lock: async (_file, options) => {
    options.onCompromised(Object.assign(new Error('stale'), { code: 'ECOMPROMISED' }));
    return async () => {};
  }, recordEvent: async (...args) => events.push(args), shutdown: (...args) => exits.push(args) });
  assert.equal(events[0][0], 'runtime_lock_compromised');
  assert.deepEqual(exits, [[1, 'lock_compromised']]);
});
test('previous unrecorded exit uses an injectable launchd reader only for our label', async () => {
  let calls = 0; const recorded = [];
  const options = { pid: 20, readEvents: async () => [{ event: 'ready', pid: 10 }], recordEvent: async (...args) => recorded.push(args),
    readLastExit: async () => { calls++; return -9; }, serviceName: 'dev.proxy-mate.daemon' };
  await identity.recordPreviousExit(options);
  assert.deepEqual(recorded[0][1].details, { previous_pid: 10, launchd_last_exit: -9 });
  await identity.recordPreviousExit({ ...options, serviceName: undefined });
  assert.equal(calls, 1); assert.equal(recorded[1][1].details.launchd_last_exit, null);
  await identity.recordPreviousExit({ ...options, readEvents: async () => [{ event: 'ready', pid: 10 }, { event: 'stopping', pid: 10 }] });
  assert.equal(recorded.length, 2);
});

async function daemonFixture(failPhase) {
  const source = await fs.readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function runDaemon('), source.indexOf('// ---- CLI ----'));
  const events = [], exits = [];
  const noOp = async () => {};
  const internal = Symbol();
  const deps = {
    readEnvironment: () => undefined,
    configureConnectionAttempts() {}, acquireRuntime: async () => { if (failPhase === 'lock') throw Object.assign(new Error('busy'), { code: 'RUNTIME_BUSY' }); return noOp; }, reconcileRuntime: async () => { if (failPhase === 'reconcile') throw Object.assign(new Error('stale'), { code: 'RECOVERY_FAILED' }); },
    sweepStaleTempFiles: noOp, STATE_DIR: home, startLogMaintenance: () => () => {},
    startEventLoopMetrics: () => ({ stop() {} }), startLiveness: async () => ({ stop: noOp }),
    ProxyEngine: class { port = 123; sessionId = 'session'; diagnostics = []; start = noOp; },
    readState: async () => null, PacServer: class {}, createDaemonPacServer: () => ({}), makeTools: () => ({ stop_operator_ui: noOp, [internal]: { stop_proxy: async () => ({}) } }),
    loadDomainsConfig: async () => ({ domains: failPhase === 'routing' ? ['example.test'] : [], tls_passthrough: [] }),
    applyPacRouting: async () => { throw Object.assign(new Error('routing failed'), { code: 'ROUTING_FAILED' }); }, validateRoutingDomains() {},
    PROXY_PORT_DEFAULT: 123, PAC_PORT_DEFAULT: 124, DEFAULT_CONTROL_PORT: 125,
    INTERNAL_CAPTURE_CONTROL: internal, clearPidFile: noOp, clearState: noOp, patchState: noOp,
    installShutdownHandlers: (cleanup) => async (...args) => { exits.push(args); await cleanup(); },
    ensureCA: async () => { if (failPhase === 'ca') throw Object.assign(new Error('bad ca'), { code: 'CA_INVALID' }); },
    CA_CERT: 'fake', loadRules: async () => [], ControlServer: class { port = 125; start = noOp; },
    writePidFile: noOp, readProcessIdentity: async () => ({ boot_session: 'boot', pid_started_at: 'start' }),
    recordPreviousExit: noOp, recordRuntimeEvent: async (event, data) => events.push({ event, ...data }),
    logLine() {}, errorFields: e => ({ error_code: e.code, error_message: e.message }),
    process: { pid: 42, stderr: { write() {} } }, performance, setInterval() {}, url: { fileURLToPath: () => 'fake' },
  };
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
  await new AsyncFunction(...Object.keys(deps), `${body.replaceAll('import.meta.url', "'file:///fake'")}\nawait runDaemon({skipRouting:${failPhase !== 'routing'},skipTrust:true,skipHostTrust:true});`)(...Object.values(deps));
  return { events, exits };
}
test('daemon startup failure records phase and shuts down with startup_failed', async () => {
  const { events, exits } = await daemonFixture('ca');
  assert.deepEqual(events.find(e => e.event === 'startup_failed')?.details, { phase: 'ca', error_code: 'CA_INVALID', error_message: 'bad ca' });
  assert.deepEqual(exits, [[1, 'startup_failed']]);
});
test('daemon ready event includes all startup timings and actual ports', async () => {
  const { events } = await daemonFixture();
  const ready = events.find(e => e.event === 'ready');
  for (const phase of ['lock', 'reconcile', 'session_restore', 'ca', 'host_trust', 'engine', 'routing', 'trust', 'rules', 'watcher', 'control']) assert.equal(typeof ready.details[`${phase}_ms`], 'number');
  assert.equal(ready.details.proxy_port, 123); assert.equal(ready.details.pac_port, 124); assert.equal(ready.details.control_port, 125);
});

test('SIGTERM fallback, SIGINT and a hung journal have bounded shutdowns', async () => {
  for (const [signal, reason] of [['SIGTERM', 'signal_sigterm'], ['SIGINT', 'signal_sigint']]) {
    const proc = fakeProcess(); const events = [];
    const shutdown = runtime.installShutdownHandlers(async () => {}, {
      process: proc, eventTimeoutMs: 10, readIntent: async () => null, clearIntent: async () => {},
      recordEvent: (event, data) => { events.push({ event, ...data }); return new Promise(() => {}); },
    });
    proc.emit(signal);
    await new Promise(resolve => setImmediate(resolve));
    await shutdown();
    assert.equal(proc.exited, 0); assert.equal(events[0].reason, reason);
  }
});

test('reconcile recovers a reused pid but refuses a matching live owner', async () => {
  const owner = { pid: 12, boot_session: 'boot', pid_started_at: 'start', routing_active: false };
  const readers = { isAlive: () => true, readStartTime: async () => 'start', readBootSession: async () => 'boot' };
  await state.writeState(owner);
  await assert.rejects(runtime.reconcileRuntime(readers), { code: 'RUNTIME_BUSY' });
  await runtime.reconcileRuntime({ ...readers, readBootSession: async () => 'reboot' });
  assert.equal(await state.readState(), null);
});


test('early startup failures are attributed before resources exist', async () => {
  for (const phase of ['lock', 'reconcile']) {
    const { events, exits } = await daemonFixture(phase);
    assert.equal(events.find(e => e.event === 'startup_failed').details.phase, phase);
    assert.deepEqual(exits, [[1, 'startup_failed']]);
  }
});

test('two real uncaught exceptions preserve the second fatal event before exit', async () => {
  const directory = await fs.mkdtemp(path.join(home, 'fatal-'));
  const moduleUrl = new URL('../src/lib/runtime.mjs', import.meta.url).href;
  const script = `import { installShutdownHandlers } from ${JSON.stringify(moduleUrl)};
    installShutdownHandlers(() => new Promise(resolve => setTimeout(resolve, 100)));
    setTimeout(() => { throw new Error('first fatal'); }, 0);
    setTimeout(() => { throw new Error('second fatal'); }, 20);`;
  await assert.rejects(promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, PROXY_MATE_HOME: directory }, timeout: 15000,
  }), error => error.code === 1 && !error.killed);
  const events = (await fs.readFile(path.join(directory, 'daemon.events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(events.some(e => e.event === 'fatal_error' && e.error_message === 'second fatal'));
  assert.equal(events.filter(e => e.event === 'stopping').length, 1);
});

test('a routing failure keeps its routing phase attribution', async () => {
  const { events } = await daemonFixture('routing');
  assert.equal(events.find(e => e.event === 'startup_failed').details.phase, 'routing');
});
