import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseOptions, summarize, failsQualification, stopChild } from '../scripts/lib/load-support.mjs';

test('load options reject typos and unsafe numeric inputs', () => {
  assert.equal(parseOptions([]).cpuFactor, 0);
  assert.equal(parseOptions(['--seconds', '4', '--bridges', '2', '--guardian']).guardian, true);
  for (const args of [['--seconds', 'NaN'], ['--seconds', '0'], ['--bridges', '1.5'], ['--cpu-factor', '-1'], ['--wat'], ['--json']]) {
    assert.throws(() => parseOptions(args), { code: 'INVALID_LOAD_OPTIONS' });
  }
});

test('load statistics preserve codes, percentiles and qualification boundaries', () => {
  const s = summarize([{ outcome: 'ok', latency_ms: 10 }, { outcome: 'HTTP_503', latency_ms: 40 }]);
  assert.equal(s.success, 1); assert.equal(s.failures, 1); assert.equal(s.outcomes.HTTP_503, 1);
  assert.deepEqual(s.latency_ms, { p50: 10, p95: 40, p99: 40, max: 40 });
  assert.equal(failsQualification({ requests: { total: 100, failures: 1 }, guardian: { timeline: [] } }), false);
  assert.equal(failsQualification({ requests: { total: 100, failures: 2 }, guardian: { timeline: [] } }), true);
  for (const action of ['restart_requested', 'terminating_owner']) {
    assert.equal(failsQualification({ requests: { total: 1, failures: 0 }, guardian: { timeline: [{ action }] } }), true);
  }
});

test('owned busy children receive SIGKILL if SIGTERM is ignored', { timeout: 4000 }, async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"]);
  try {
    await new Promise(resolve => child.stdout.once('data', resolve));
    await stopChild(child, 50);
    assert.equal(child.signalCode, 'SIGKILL');
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});

test('four-second real daemon smoke reports traffic and cleans all owned resources', { timeout: 20000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'load-smoke-'));
  const output = path.join(dir, 'report.json');
  const child = spawn(process.execPath, ['scripts/load-qualify.mjs', '--seconds', '4', '--cpu-factor', '0', '--bridges', '2', '--guardian', '--subscriptions', '--concurrency', '2', '--json', output], { env: { ...process.env, PROXY_MATE_HOME: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', c => { stderr += c; }); child.stdout.resume();
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 0, stderr);
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(report.config.bridges, 2);
    assert.ok(report.requests.success > 0);
    assert.ok(report.probes.rpc.total > 0);
    assert.ok(report.probes.readiness.total > 0);
    assert.ok(report.probes.subscriptions.total > 0);
    assert.ok(report.guardian.timeline.length >= 2);
    assert.equal(typeof report.guardian.timeline[0].probe_latency_ms, 'number');
    assert.ok(report.samples.length >= 3);
    assert.ok(report.metrics_snapshots.length > 0);
    assert.ok(report.durations.load_ms >= 3900);
    assert.equal(report.cleanup.temp_removed, true);
    await assert.rejects(stat(report.state_dir), { code: 'ENOENT' });
    for (const processInfo of report.children) {
      assert.equal(processInfo.stopped, true);
      assert.throws(() => process.kill(processInfo.pid, 0), { code: 'ESRCH' });
    }
  } finally { child.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }); }
});

test('HTTP observation captures rejection status without extra requests', async () => {
  const { createHttpObserver, listen, closeServer, request } = await import('../scripts/lib/load-support.mjs');
  const { default: http } = await import('node:http');
  let calls = 0;
  const server = http.createServer((_req, res) => { calls++; res.writeHead(429); res.end('{}'); });
  const observer = createHttpObserver();
  try {
    const port = await listen(server);
    const result = await observer.run(() => request({ host: '127.0.0.1', port }));
    assert.equal(result.status, 429); assert.equal(calls, 1);
  } finally { observer.close(); await closeServer(server); }
});

test('SIGINT writes an interrupted report and reaps its daemon', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'load-interrupt-'));
  const output = path.join(dir, 'report.json');
  const child = spawn(process.execPath, ['scripts/load-qualify.mjs', '--seconds', '60', '--bridges', '0', '--concurrency', '1', '--json', output], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.resume();
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on('data', data => { if (data.toString().includes('Load started')) resolve(); });
      exited.then(() => reject(new Error('Harness exited before load began')));
    });
    child.kill('SIGINT');
    assert.equal(await exited, 130);
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(report.interrupted, 'SIGINT');
    assert.equal(report.cleanup.all_children_stopped, true);
    assert.equal(report.cleanup.temp_removed, true);
    for (const entry of report.children) assert.throws(() => process.kill(entry.pid, 0), { code: 'ESRCH' });
  } finally { child.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }); }
});
