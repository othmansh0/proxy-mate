#!/usr/bin/env node
/**
 * Isolated load qualification; no host routing, CA trust, or live daemon access.
 * node scripts/load-qualify.mjs [options]
 * --seconds 60                Measured load duration (startup/cleanup excluded).
 * --cpu-factor 0              round(factor * os.cpus().length) default-priority
 *                             busy-loop children. Heavy settings are opt-in.
 * --bridges 4                 Independent real readiness + cheap RPC loops.
 * --subscriptions             Extra status poll per bridge every 750 ms.
 * --background-band           Start daemon via /usr/sbin/taskpolicy -b (macOS).
 * --guardian                  Real guardian tick every 3 s, termination recorded.
 * --allow-kill                Permit guardian to terminate ONLY our daemon.
 * --assert-no-kill            Fail on restart/termination decisions or >1% failed
 *                             traffic (also fail if no traffic completed).
 * --upstream-latency-ms 50     Delay local upstream responses.
 * --concurrency 16            Concurrent absolute-URI HTTP traffic loops.
 * --json <path>               Report path (default: timestamped file in OS temp).
 * SIGINT/SIGTERM stop load, reap owned children, remove state, and write report.
 * Run this entry in a fresh process: src modules capture PROXY_MATE_HOME at import.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createHttpObserver, parseOptions, summarize, failsQualification, loadError, outcome, stopChild, request, listen, closeServer } from './lib/load-support.mjs';

const config = parseOptions(process.argv.slice(2));
const started = Date.now();
const home = await mkdtemp(path.join(os.tmpdir(), 'proxy-load-'));
process.env.PROXY_MATE_HOME = home; // MUST precede every src import, including guardian dependencies.
const controller = new AbortController();
const { signal } = controller;
let interrupted = null;
const interrupt = name => { interrupted = name; controller.abort(); };
const onInt = () => interrupt('SIGINT');
const onTerm = () => interrupt('SIGTERM');
process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
const children = [], tasks = [], samples = [], metrics = [], timeline = [], terminations = [];
const observer = createHttpObserver();
const events = { requests: [], readiness: [], rpc: [], subscriptions: [], guardian: [] };
const report = { schema_version: 1, config, state_dir: home, started_at: new Date(started).toISOString(),
  durations: {}, samples, metrics_snapshots: metrics, guardian: { timeline, terminations, counts: {} } };
let daemon, upstream, auth, loadStarted, loadEnded, failure;
const upstreamTimers = new Set();
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const running = child => child?.pid && child.exitCode === null && child.signalCode === null;
function child(command, args, role) {
  const proc = spawn(command, args, { cwd: root, env: { ...process.env, PROXY_MATE_HOME: home }, stdio: 'ignore' });
  const info = { role, process: proc, error: null };
  proc.on('error', error => { info.error = error.code ?? 'SPAWN_FAILED'; controller.abort(); });
  children.push(info); return proc;
}
const pause = ms => delay(ms, null, { signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
async function loop(fn, interval = 0) {
  while (!signal.aborted) {
    const before = performance.now(); await fn();
    if (!signal.aborted) await pause(Math.max(1, interval - (performance.now() - before)));
  }
}
async function measured(bucket, fn) {
  const start = performance.now();
  const result = await observer.run(fn);
  if (!signal.aborted) {
    const status = result.status;
    const label = status >= 400 ? `HTTP_${status}` : result.error ? outcome(result.error) : result.value === false ? 'unhealthy' : 'ok';
    bucket.push({ outcome: label, latency_ms: performance.now() - start });
  }
  return result.value;
}
try {
  const [{ waitForReadyDaemon }, { callDaemon, probeDaemon }, { createGuardian }, { newClientId }] = await Promise.all([
    import('../src/lib/daemon-connection.mjs'), import('../src/lib/control.mjs'), import('../src/lib/guardian.mjs'),
    import('../src/lib/client-identity.mjs'),
  ]);
  upstream = http.createServer((_req, res) => {
    const timer = setTimeout(() => { upstreamTimers.delete(timer); res.writeHead(200, { 'content-type': 'text/plain' }); res.end('load-ok'); }, config.upstreamLatencyMs);
    upstreamTimers.add(timer);
    res.on('close', () => { clearTimeout(timer); upstreamTimers.delete(timer); });
  });
  const upstreamPort = await listen(upstream);
  // Hold all reservations simultaneously, so the three ports are distinct.
  const reservations = [http.createServer(), http.createServer(), http.createServer()];
  let ports;
  try { ports = await Promise.all(reservations.map(listen)); }
  finally { await Promise.all(reservations.map(closeServer)); }
  report.ports = { proxy: ports[0], pac: ports[1], control: ports[2], upstream: upstreamPort };
  const args = [fileURLToPath(new URL('../src/server.mjs', import.meta.url)), '--daemon', '--no-routing', '--no-trust-ca', '--no-host-trust',
    '--proxy-port', String(ports[0]), '--pac-port', String(ports[1]), '--control-port', String(ports[2])];
  daemon = config.backgroundBand ? child('/usr/sbin/taskpolicy', ['-b', process.execPath, ...args], 'daemon') : child(process.execPath, args, 'daemon');
  const startupDeadline = Date.now() + 30000;
  while (!signal.aborted && Date.now() < startupDeadline && running(daemon)) {
    try { auth = JSON.parse(await readFile(path.join(home, 'handshake.json'), 'utf8')); if (auth?.controlUrl && auth?.token) break; }
    catch (error) { if (!['ENOENT'].includes(error.code) && !(error instanceof SyntaxError)) throw error; }
    await pause(50);
  }
  if (!auth?.token) throw loadError('LOAD_STARTUP_FAILED', 'Isolated daemon did not publish its handshake.');
  for (let i = 0; i < Math.round(config.cpuFactor * os.cpus().length); i++) {
    child(process.execPath, ['-e', 'for (;;) { Math.sqrt(Math.random()); }'], 'cpu');
  }
  report.cpu_children = children.filter(c => c.role === 'cpu').length;
  loadStarted = Date.now();
  console.log(`Load started: daemon ${daemon.pid}; CPU children ${report.cpu_children}; bridges ${config.bridges}`);
  const endTimer = setTimeout(() => controller.abort(), config.seconds * 1000);
  // Observe raw readiness HTTP outcomes without replacing the real readiness policy.
  const realProbe = async (...args) => {
    const start = performance.now();
    const ok = await probeDaemon(...args);
    if (!ok && performance.now() - start >= (args[2] ?? 1500)) {
      throw loadError('DAEMON_TIMEOUT', 'Real daemon probe exceeded its deadline');
    }
    return ok;
  };
  const readinessProbe = async (...args) => measured(events.readiness, () => realProbe(...args));
  for (let i = 0; i < config.bridges; i++) {
    const clientId = newClientId();
    const bridgeCall = bucket => measured(bucket, async () => {
      const ready = await waitForReadyDaemon({ timeoutMs: 15000, signal, client: { client_id: clientId }, probe: readinessProbe });
      if (!ready) throw loadError('DAEMON_TIMEOUT', 'Readiness deadline exceeded');
      return callDaemon({ ...ready, tool: 'get_proxy_status', args: {}, timeoutMs: 2000, signal, client: { client_id: clientId } });
    });
    tasks.push(loop(() => bridgeCall(events.rpc), 100));
    if (config.subscriptions) tasks.push(loop(() => bridgeCall(events.subscriptions), 750));
  }
  for (let i = 0; i < config.concurrency; i++) tasks.push(loop(() => measured(events.requests, async () => {
    const response = await request({ host: '127.0.0.1', port: ports[0], path: `http://127.0.0.1:${upstreamPort}/load` }, { timeoutMs: 10000, signal });
    if (response.status !== 200) throw loadError(`HTTP_${response.status}`, 'Proxied request failed');
    if (response.body !== 'load-ok') throw loadError('INVALID_UPSTREAM_RESPONSE', 'Unexpected upstream body');
  })));
  if (config.guardian) {
    let probeLatency = null;
    const tick = createGuardian({
      probe: async (...args) => {
        const start = performance.now();
        try { return await measured(events.guardian, () => realProbe(...args)); }
        finally { probeLatency = performance.now() - start; }
      },
      terminate: async pid => {
        terminations.push({ timestamp: new Date().toISOString(), pid, dry_run: !config.allowKill });
        if (pid !== daemon.pid || !running(daemon)) return false;
        if (config.allowKill) await stopChild(daemon);
        return true;
      },
      // Routing is forbidden in this harness, even on unexpected daemon state.
      restore: async () => { throw loadError('LOAD_ROUTING_FORBIDDEN', 'Harness cannot restore host routing'); },
    });
    tasks.push(loop(async () => {
      probeLatency = null; const timestamp = new Date().toISOString(), start = performance.now();
      try { timeline.push({ timestamp, ...await tick(), latency_ms: performance.now() - start, probe_latency_ms: probeLatency, requests_success: events.requests.filter(e => e.outcome === 'ok').length }); }
      catch (error) { timeline.push({ timestamp, action: 'error', code: outcome(error), probe_latency_ms: probeLatency }); }
    }, 3000));
  }
  tasks.push(loop(async () => {
    let rss = null;
    try { const { stdout } = await exec('/bin/ps', ['-o', 'rss=', '-p', String(daemon.pid)], { timeout: 2000 }); rss = Number(stdout.trim()) * 1024; }
    catch { /* A vanished daemon or slow ps is itself observable as a null RSS. */ }
    samples.push({ timestamp: new Date().toISOString(), elapsed_ms: Date.now() - loadStarted, loadavg: os.loadavg(), daemon_rss_bytes: rss });
    for (const endpoint of ['/metrics', '/health']) {
      if (signal.aborted) break;
      try {
        const response = await request({ host: '127.0.0.1', port: ports[2], path: endpoint, headers: { authorization: `Bearer ${auth.token}` } }, { signal });
        let body = response.body; try { body = JSON.parse(body); } catch { /* Prometheus text is valid too. */ }
        metrics.push({ timestamp: new Date().toISOString(), endpoint, status: response.status, body });
      } catch (error) { if (!signal.aborted) metrics.push({ timestamp: new Date().toISOString(), endpoint, error: outcome(error) }); }
    }
  }, 1000));
  try { await Promise.all(tasks); }
  finally { clearTimeout(endTimer); loadEnded = Date.now(); }
  const childError = children.find(c => c.error);
  if (childError) throw loadError(childError.error, 'Failed to spawn load child');
} catch (error) {
  failure = error; report.error = { code: error.code ?? 'LOAD_FAILED', message: error.message }; process.exitCode = 1;
} finally {
  controller.abort();
  // Stop CPU competitors first, leaving the daemon scheduling room to clean up.
  await Promise.all(children.filter(c => c.role === 'cpu').map(c => stopChild(c.process, 1000)));
  await stopChild(daemon);
  await Promise.allSettled(tasks);
  for (const timer of upstreamTimers) clearTimeout(timer);
  await closeServer(upstream);
  report.children = children.map(c => ({ role: c.role, pid: c.process.pid ?? null, stopped: !running(c.process), exit_code: c.process.exitCode, signal: c.process.signalCode, spawn_error: c.error }));
  await rm(home, { recursive: true, force: true });
  report.cleanup = { temp_removed: true, all_children_stopped: report.children.every(c => c.stopped) };
  observer.close();
  process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm);
}
report.interrupted = interrupted;
report.durations = { startup_ms: loadStarted ? loadStarted - started : null, load_ms: loadStarted ? (loadEnded ?? Date.now()) - loadStarted : 0, total_ms: Date.now() - started };
report.requests = summarize(events.requests);
report.probes = Object.fromEntries(['readiness', 'rpc', 'subscriptions', 'guardian'].map(key => [key, summarize(events[key])]));
for (const { action } of timeline) report.guardian.counts[action] = (report.guardian.counts[action] ?? 0) + 1;
report.qualification_passed = !failure && !interrupted && !failsQualification(report);
if (config.assertNoKill && !report.qualification_passed) process.exitCode = 1;
if (interrupted) process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
report.report_path = path.resolve(config.json ?? path.join(os.tmpdir(), `proxy-load-report-${started}-${process.pid}.json`));
await writeFile(report.report_path, JSON.stringify(report, null, 2) + '\n');
console.log(`Report: ${report.report_path}`);
console.log(`Load ${report.durations.load_ms} ms: requests ${report.requests.success}/${report.requests.total} ok; p95 ${report.requests.latency_ms.p95 ?? '-'} ms; guardian ${JSON.stringify(report.guardian.counts)}; children stopped=${report.cleanup.all_children_stopped}`);
if (failure) console.error(`${failure.code ?? 'LOAD_FAILED'}: ${failure.message}`);
