import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { ControlServer } from '../src/lib/control.mjs';
import { clearPacRouting } from '../src/lib/pac.mjs';
import { patchState, clearState, readState } from '../src/lib/state.mjs';
import http from 'node:http';
import { once } from 'node:events';
import { ProxyEngine } from '../src/lib/proxy.mjs';
import { makeTools } from '../src/lib/tools.mjs';
import { INTERNAL_CAPTURE_CONTROL } from '../src/lib/capture-lease.mjs';
import { plistXml, GUARDIAN_LABEL } from '../src/lib/launchagent.mjs';
import { STATE_DIR } from '../src/lib/config.mjs';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('control stop bounds an uncooperative serial queue at three seconds', { timeout: 5000 }, async () => {
  const control = new ControlServer({ port: 0, tools: {} });
  await control.start();
  control.queue = new Promise(resolve => setTimeout(resolve, 4500));
  const started = performance.now();
  assert.equal((await control.stop()).queue_drained, false);
  assert.ok(performance.now() - started >= 2900);
  assert.ok(performance.now() - started < 4000);
});

test('routing commands share a shrinking per-call timeout cap', async () => {
  await patchState({ pid: process.pid, routing_active: true, network_service: 'Fake', pac_url: 'owned', prior_auto_proxy: { enabled: false, url: '' } });
  let remaining = 6000;
  const timeouts = [];
  await clearPacRouting({ loadavg: () => [999], cores: 1, timeoutCapMs: () => remaining,
    run: async (_file, args, options) => {
      timeouts.push(options.timeout); remaining -= 2000;
      return { stdout: args[0] === '-getautoproxyurl' ? 'URL: owned\nEnabled: Yes\n' : '' };
    } });
  assert.deepEqual(timeouts, [6000, 4000, 2000]);
});

test('daemon and guardian have separate launchd exit budgets', () => {
  const options = { programArgs: ['/node', '/fake/src/server.mjs'] };
  assert.match(plistXml(options), /<key>ExitTimeOut<\/key>\s*<integer>30<\/integer>/);
  assert.match(plistXml({ ...options, label: GUARDIAN_LABEL }), /<key>ExitTimeOut<\/key>\s*<integer>20<\/integer>/);
});

test('shutdown deadline defaults to twenty seconds', async () => {
  const source = await fs.readFile(new URL('../src/lib/runtime.mjs', import.meta.url), 'utf8');
  assert.match(source, /timeoutMs = 20_000/);
});

// Exercise the actual daemon closure with injected dependencies, without starting
// a daemon or touching system routing. This keeps shutdown ordering testable.
async function cleanupFixture({ routingFails = false, queueMs = 0, stopCapture } = {}) {
  const source = await fs.readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('  const cleanup = async ('), source.indexOf('  const shutdown = installShutdownHandlers', source.indexOf('async function runDaemon')));
  const events = [], logs = [], state = { capture_lease: { expires_at: new Date(Date.now() + 60000).toISOString() } };
  const internal = Symbol();
  const deps = {
    presenceTimer: undefined,
    stopLogMaintenance() {}, startupSettled: Promise.resolve(),
    ctrl: { stop: async () => { events.push('control'); await delay(queueMs); } },
    tools: { stop_operator_ui: async () => events.push('ui'), [internal]: {
      stop_proxy: async (_args, options = {}) => {
        if (options.routingOnly) { events.push('routing'); if (routingFails) throw Error('routing failed'); return {}; }
        events.push('drain'); assert.ok(options.graceMs >= 0); return stopCapture ? stopCapture(_args, options) : {};
      },
    } },
    INTERNAL_ROUTING_CONTROL: Symbol(), recordRoutingSuspension: async () => {},
    INTERNAL_CAPTURE_CONTROL: internal, engine: { sessionId: 'active' },
    clearPidFile: async () => events.push('pid'), readState: async () => state,
    clearState: async () => {}, patchState: async patch => Object.assign(state, patch),
    stopObservability: async () => events.push('observability'), releaseRuntime: async () => events.push('release'),
    logLine: (...args) => { if (args[1] === 'shutdown step') logs.push(args[2]); }, errorFields: e => ({ message: e.message }),
    readEnvironment: () => undefined, defaultDrainMs: () => 8000,
  };
  const cleanup = new Function(...Object.keys(deps), `${body}; return cleanup;`)(...Object.values(deps));
  return { cleanup, events, logs, state };
}
for (const routingFails of [false, true]) test(`routing first and lock released when routing fails=${routingFails}`, async () => {
  const f = await cleanupFixture({ routingFails, queueMs: 100 });
  await f.cleanup();
  assert.deepEqual(f.events, ['routing', 'control', 'ui', 'drain', 'pid', 'observability', 'release']);
  assert.ok(f.logs.every(row => typeof row.ok === 'boolean' && row.elapsed_ms >= 0));
  assert.equal(f.logs.find(row => row.step === 'routing').ok, !routingFails);
  assert.equal(f.state.active_session_id, routingFails ? undefined : 'active');
});

test('a slow upstream completes through the daemon cleanup drain', async t => {
  let received;
  const incoming = new Promise(resolve => { received = resolve; });
  const upstream = http.createServer((_req, res) => { received(); setTimeout(() => res.end('complete'), 700); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const engine = new ProxyEngine(); await engine.start({ port: 0 });
  t.after(() => engine.stop({ graceMs: 0 }));
  const tools = makeTools({ engine, pacServer: { stop: async () => {} }, mode: 'daemon' });
  const response = new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: engine.port,
      path: `http://127.0.0.1:${upstream.address().port}/slow` }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve(body));
    });
    req.on('error', reject);
  });
  await incoming;
  const f = await cleanupFixture({ stopCapture: (...args) => tools[INTERNAL_CAPTURE_CONTROL].stop_proxy(...args) });
  await Promise.all([f.cleanup(), response.then(body => assert.equal(body, 'complete'))]);
  assert.equal(engine.isRunning(), false);
});

test('routing restores before a three-second control queue settles', async () => {
  const f = await cleanupFixture({ queueMs: 3100 });
  const stopping = f.cleanup();
  await delay(50);
  assert.deepEqual(f.events, ['routing', 'control']);
  await stopping;
});

test('routing budget exhaustion issues no further system command', async () => {
  await patchState({ pid: process.pid, routing_active: true, network_service: 'Fake', pac_url: 'owned' });
  let calls = 0;
  await assert.rejects(clearPacRouting({ timeoutCapMs: () => 0, run: async () => { calls++; } }), { code: 'ROUTING_COMMAND_TIMEOUT' });
  assert.equal(calls, 0);
});

test('internal routing suspension marks state after safe restore', async () => {
  const source = await fs.readFile(new URL('../src/lib/tools.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('  async function stop_proxy('), source.indexOf('  async function set_proxy_routing'));
  const state = {}; let restored = false;
  const stop = new Function('clearPacRouting', 'patchState', 'pacServer', 'run', `${body}; return stop_proxy;`)(
    async options => { restored = true; assert.equal(options.timeoutCapMs(), 123); },
    async patch => Object.assign(state, patch), {},
  );
  await stop({}, { routingOnly: true, timeoutCapMs: () => 123 });
  assert.equal(restored, true);
  assert.equal(state.routing_suspended.reason, 'daemon_shutdown');
  assert.ok(Number.isFinite(Date.parse(state.routing_suspended.at)));
});

test('routing suspension preserves durable claims and its state marker', async () => {
  await clearState();
  const claimsPath = `${STATE_DIR}/routing-claims.json`;
  const claims = JSON.stringify({ claims: [{ claim_id: 'keep-for-restart' }] });
  await fs.writeFile(claimsPath, claims);
  const tools = makeTools({ engine: {}, pacServer: { stop: async () => {} }, mode: 'daemon' });
  await tools[INTERNAL_CAPTURE_CONTROL].stop_proxy({}, { routingOnly: true, timeoutCapMs: () => 6000 });
  assert.equal((await readState()).routing_suspended.reason, 'daemon_shutdown');
  assert.equal(await fs.readFile(claimsPath, 'utf8'), claims);
});

test('exhausted cleanup budget still drains immediately and releases the lock', async () => {
  const f = await cleanupFixture({ queueMs: 500 });
  const started = performance.now();
  await f.cleanup(started + 150);
  assert.ok(performance.now() - started < 400);
  assert.ok(f.events.includes('drain'));
  assert.equal(f.events.at(-1), 'release');
  assert.equal(f.logs.find(row => row.step === 'control').ok, false);
});
