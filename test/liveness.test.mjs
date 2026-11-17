import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Worker } from 'node:worker_threads';
import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { startLiveness, probeLiveness } from '../src/lib/liveness.mjs';
import { startEventLoopMetrics } from '../src/lib/event-loop-metrics.mjs';
import { increment, registerGauge, snapshotMetrics, resetMetrics } from '../src/lib/metrics.mjs';

const execFileP = promisify(execFile);
async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'liveness-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
function request(url, token) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { agent: false, headers: token ? { Authorization: `Bearer ${token}` } : {} }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
  });
}

test('authenticated liveness publishes private discovery, fresh heartbeat and progress', async t => {
  resetMetrics();
  const dir = await directory(t);
  const live = await startLiveness({ directory: dir, heartbeatMs: 20, publishMs: 20 });
  t.after(() => live.stop());
  const file = path.join(dir, 'liveness.json');
  const record = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal(record.pid, process.pid);
  assert.equal(record.token.length, 64);
  assert.equal(record.url, live.url);
  assert.equal((await request(live.url)).status, 401);
  assert.equal((await request(live.url, 'wrong')).status, 401);
  assert.equal((await request(live.url, 'x'.repeat(64))).status, 401);
  let body = await probeLiveness({ directory: dir });
  assert.equal(body.verdict, 'healthy');
  assert.equal(body.lag_p99_ms, null);
  assert.deepEqual(body.progress, { flows_completed: 0, bytes: 0, active_connections: 0 });
  increment('proxy.flows_completed', 7);
  increment('proxy.bytes', 120);
  const remove = registerGauge('proxy.active_connections', () => 2);
  t.after(remove);
  const removeLag = registerGauge('loop.lag_p99_ms', () => 12.5);
  const removeElu = registerGauge('loop.elu', () => 0.25);
  t.after(removeLag); t.after(removeElu);
  // Outlast the healthy threshold to prove heartbeats actually keep advancing.
  await delay(1100);
  body = await probeLiveness({ directory: dir });
  assert.equal(body.verdict, 'healthy');
  assert.ok(body.heartbeat_age_ms < 1000);
  assert.deepEqual(body.progress, { flows_completed: 7, bytes: 120, active_connections: 2 });
  assert.equal(body.lag_p99_ms, 12.5);
  assert.equal(body.elu, 0.25);
  await live.stop();
  await live.stop();
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  assert.equal(await probeLiveness({ directory: dir }), null);
});

test('stop preserves a replacement discovery record', async t => {
  const dir = await directory(t);
  const live = await startLiveness({ directory: dir });
  t.after(() => live.stop());
  const file = path.join(dir, 'liveness.json');
  await fs.writeFile(file, JSON.stringify({ pid: process.pid + 1 }));
  await live.stop();
  assert.equal(JSON.parse(await fs.readFile(file)).pid, process.pid + 1);
});

test('worker answers an independent child while the main loop is blocked', { timeout: 8000 }, async t => {
  const dir = await directory(t);
  const live = await startLiveness({ directory: dir, heartbeatMs: 20 });
  t.after(() => live.stop());
  // IPC handshake ensures the child is ready before the two-second block.
  const source = `import http from 'node:http';
    process.send('ready');
    process.on('message', ({url, token}) => setTimeout(() => {
      const start = Date.now();
      http.get(url, {agent:false, headers:{Authorization:'Bearer '+token}}, res => {
        let body=''; res.on('data', d=>body+=d); res.on('end',()=>{
          process.send({body:JSON.parse(body), elapsed:Date.now()-start}); process.disconnect();
        });
      }).on('error', e=>{throw e});
    }, 1650));`;
  const childFile = path.join(dir, 'probe.mjs');
  await fs.writeFile(childFile, source);
  const child = fork(childFile, [], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
  const result = new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
  child.send(JSON.parse(await fs.readFile(path.join(dir, 'liveness.json'))));
  const start = Date.now();
  while (Date.now() - start < 2200) { /* one core, bounded blocking experiment */ }
  const { body, elapsed } = await result;
  assert.ok(elapsed < 500, `worker response took ${elapsed}ms`);
  assert.ok(body.heartbeat_age_ms >= 1500, `heartbeat age ${body.heartbeat_age_ms}ms`);
  assert.equal(body.verdict, 'slow');
});

test('probe rejects malformed and non-loopback discovery without a request', async () => {
  for (const url of ['http://example.com/livez', 'https://127.0.0.1/livez', 'http://127.0.0.1@example.com/livez', 'file:///tmp/livez']) {
    assert.equal(await probeLiveness({ read: async () => JSON.stringify({ url, token: 'x' }) }), null);
  }
  assert.equal(await probeLiveness({ read: async () => 'broken' }), null);
});

test('loop metrics register finite gauges and stop unregisters them', async () => {
  resetMetrics();
  const loop = startEventLoopMetrics({ intervalMs: 40, resolutionMs: 5 });
  try {
    await delay(120);
    const snapshot = loop.latest();
    for (const key of ['lag_p50_ms', 'lag_p99_ms', 'lag_max_ms', 'elu']) {
      assert.equal(typeof snapshot[key], 'number');
      assert.ok(Number.isFinite(snapshot[key]));
      assert.equal(snapshotMetrics().gauges[`loop.${key}`], snapshot[key]);
    }
    assert.ok(snapshot.lag_p99_ms >= snapshot.lag_p50_ms);
    assert.ok(snapshot.elu >= 0 && snapshot.elu <= 1);
  } finally { loop.stop(); }
  assert.equal(snapshotMetrics().gauges['loop.elu'], undefined);
});

test('timers and worker do not retain an otherwise idle process; stop releases handles', async () => {
  const loopUrl = new URL('../src/lib/event-loop-metrics.mjs', import.meta.url).href;
  const liveUrl = new URL('../src/lib/liveness.mjs', import.meta.url).href;
  for (const stop of [false, true]) {
    await execFileP(process.execPath, ['--input-type=module', '-e', `
      import {startEventLoopMetrics} from ${JSON.stringify(loopUrl)};
      import {startLiveness} from ${JSON.stringify(liveUrl)};
      import {mkdtemp, rm} from 'node:fs/promises';
      import os from 'node:os'; import path from 'node:path';
      const dir = await mkdtemp(path.join(os.tmpdir(), 'liveness-exit-'));
      const loop = startEventLoopMetrics();
      const live = await startLiveness({directory:dir});
      if (${stop}) { loop.stop(); await live.stop(); }
      await rm(dir, {recursive:true, force:true});
    `], { timeout: 5000 });
  }
});


test('worker reports stalled heartbeats and rejects other paths', async t => {
  const buffer = new SharedArrayBuffer(8);
  Atomics.store(new BigInt64Array(buffer), 0, BigInt(Date.now() - 31_000));
  const worker = new Worker(new URL('../src/lib/liveness-worker.mjs', import.meta.url), {
    execArgv: [], workerData: { buffer, token: 'test-token', port: 0, pid: process.pid,
      startedAt: Date.now(), progress: { flows_completed: 0, bytes: 0, active_connections: 0, lag_p99_ms: null, elu: null } },
  });
  t.after(() => worker.terminate());
  const { url } = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  const { body } = await request(url, 'test-token');
  assert.equal(body.verdict, 'stalled');
  assert.equal(body.pid, process.pid);
  assert.ok(body.uptime_ms >= 0);
  assert.equal((await request(url.replace('/livez', '/other'), 'test-token')).status, 404);
});

test('failed discovery publication terminates the worker', async t => {
  const dir = await directory(t);
  const file = path.join(dir, 'not-a-directory');
  await fs.writeFile(file, 'occupied');
  await assert.rejects(startLiveness({ directory: file }), { code: 'EEXIST' });
});

test('probe bounds requests and rejects malformed responses', async t => {
  let respond = false;
  const server = http.createServer((req, res) => { if (respond) res.end('invalid JSON'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const read = async () => JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/livez`, token: 'test' });
  assert.equal(await probeLiveness({ read, timeoutMs: 50 }), null);
  respond = true;
  assert.equal(await probeLiveness({ read }), null);
});
