import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';

const { BodyWorkerPool } = await import('../src/lib/body-worker-pool.mjs');
const { processCapturedBody } = await import('../src/lib/body-worker-processing.mjs');
const { snapshotMetrics } = await import('../src/lib/metrics.mjs');
const job = (buffer, extra = {}) => ({ buffer, headers: { 'content-type': 'application/json' }, flowId: 'worker-fixture', kind: 'res', captureBodyMode: 'text', maxBodySize: 5 * 1024 * 1024, ...extra });
const contents = async (result) => result.path ? fs.readFile(result.path, 'utf8') : result.inline;

test('large worker fixtures exactly match synchronous redaction and hashes', async (t) => {
  const pool = new BodyWorkerPool();
  t.after(() => pool.close());
  assert.equal(pool.workers.size, 0);
  for (const fixture of [
    { token: 'SECRET', nested: [{ password: 'SECRET', ok: 'é😀'.repeat(90000) }] },
    { auth: { deeply: 'SECRET' }, payload: 'x'.repeat(300000) },
    { items: Array.from({ length: 5000 }, () => ({ secret: 'SECRET', value: 123 })) },
  ]) {
    const input = job(Buffer.from(JSON.stringify(fixture)));
    const sync = await processCapturedBody({ ...input, flowId: 'sync-fixture' });
    const worker = await pool.process(input);
    assert.deepEqual({ ...worker, path: null }, { ...sync, path: null });
    assert.equal(await contents(worker), await contents(sync));
    assert.ok(!(await contents(worker)).includes('SECRET'));
  }
  assert.ok(pool.workers.size > 0);
});

class BrokenWorker extends EventEmitter {
  unref() {}
  postMessage() { queueMicrotask(() => this.emit('error', new Error('worker died'))); }
  terminate() { return Promise.resolve(1); }
}
class StuckWorker extends BrokenWorker { postMessage() {} }

for (const [name, Worker] of [['failure', BrokenWorker], ['timeout', StuckWorker]]) {
  test(`worker ${name} falls back safely or omits large bodies`, async (t) => {
    const pool = new BodyWorkerPool({ threshold: 1, timeoutMs: 20, workerFactory: () => new Worker() });
    t.after(() => pool.close());
    const small = await pool.process(job(Buffer.from('{"token":"SECRET"}')));
    assert.equal(await contents(small), '{"token":"[REDACTED]"}');
    const large = await pool.process(job(Buffer.from(JSON.stringify({ token: 'SECRET', data: 'x'.repeat(1100000) }))));
    assert.equal(large.omitted, 'processing_overloaded');
    assert.equal(large.path, null);
    assert.equal(large.inline, null);
    assert.ok(snapshotMetrics().counters['proxy.body_offload_degraded'] >= 2);
  });
}

test('queue is bounded and shutdown settles jobs and terminates all workers', async () => {
  let terminated = 0;
  const pool = new BodyWorkerPool({ threshold: 1, size: 1, queueLimit: 1, workerFactory: () => {
    const worker = new StuckWorker();
    worker.terminate = async () => { terminated++; };
    return worker;
  } });
  const input = job(Buffer.alloc(1100000, 'x'));
  const active = pool.process(input);
  const queued = pool.process(input);
  const full = await pool.process(input);
  assert.equal(full.omitted, 'processing_overloaded');
  assert.equal(pool.queue.length, 1);
  await pool.close();
  assert.equal((await active).omitted, 'processing_overloaded');
  assert.equal((await queued).omitted, 'processing_overloaded');
  assert.equal(pool.workers.size, 0);
  assert.equal(terminated, 1);
});

test('metadata_only never hashes and each text body is decoded once', async (t) => {
  const hash = t.mock.method(crypto, 'createHash');
  const buffer = Buffer.from('{"token":"SECRET"}');
  const decode = t.mock.method(buffer, 'toString');
  const result = await processCapturedBody(job(buffer, { captureBodyMode: 'metadata_only' }));
  assert.equal(result.sha, null);
  assert.equal(hash.mock.callCount(), 0);
  assert.equal(decode.mock.callCount(), 1);
  decode.mock.resetCalls();
  await processCapturedBody(job(buffer));
  assert.equal(decode.mock.callCount(), 1);
});

test('ProxyEngine.stop terminates lazily created workers, including before start', async () => {
  const { ProxyEngine } = await import('../src/lib/proxy.mjs');
  const engine = new ProxyEngine({ bodyWorkerOptions: { threshold: 1 } });
  await engine.bodyWorkers.process(job(Buffer.from('{"password":"SECRET"}')));
  const workers = [...engine.bodyWorkers.workers].map((slot) => slot.worker);
  assert.ok(workers.length);
  await engine.stop();
  assert.equal(engine.bodyWorkers.workers.size, 0);
  assert.ok(workers.every((worker) => worker.threadId === -1));
});

test('worker receives current additive redaction config, even after lazy startup', async (t) => {
  const pool = new BodyWorkerPool({ threshold: 1 });
  t.after(() => pool.close());
  await pool.process(job(Buffer.from('{}')));
  const previous = process.env.PROXYFAN_REDACT_BODY_FIELDS;
  process.env.PROXYFAN_REDACT_BODY_FIELDS = 'private_*';
  t.after(() => {
    if (previous === undefined) delete process.env.PROXYFAN_REDACT_BODY_FIELDS;
    else process.env.PROXYFAN_REDACT_BODY_FIELDS = previous;
  });
  const result = await pool.process(job(Buffer.from('{"private_key":"SECRET"}')));
  assert.equal(await contents(result), '{"private_key":"[REDACTED]"}');
});

test('worker parity includes forms, malformed JSON, plain text, binary and compression', async (t) => {
  const { gzipSync } = await import('node:zlib');
  const pool = new BodyWorkerPool({ threshold: 1 });
  t.after(() => pool.close());
  const cases = [
    [Buffer.from('token=SECRET&ok=yes'), { 'content-type': 'application/x-www-form-urlencoded' }],
    [Buffer.from('{token=SECRET, broken'), { 'content-type': 'application/json' }],
    [Buffer.from('Bearer SECRET password=SECRET'), { 'content-type': 'text/plain' }],
    [Buffer.from([255, 254, 128]), {}],
    [gzipSync('{"token":"SECRET"}'), { 'content-type': 'application/json', 'content-encoding': 'gzip' }],
  ];
  for (const [buffer, headers] of cases) {
    const input = job(buffer, { headers });
    const sync = await processCapturedBody(input);
    assert.deepEqual(await pool.process(input), sync);
  }
});

test('queue saturation falls back for small bodies without exposing secrets', async (t) => {
  const pool = new BodyWorkerPool({ threshold: 1, size: 1, queueLimit: 1, workerFactory: () => new StuckWorker() });
  t.after(() => pool.close());
  const large = job(Buffer.alloc(1100000, 'x'));
  const pending = [pool.process(large), pool.process(large)];
  const result = await pool.process(job(Buffer.from('{"token":"SECRET"}')));
  assert.equal(result.inline, '{"token":"[REDACTED]"}');
  await pool.close();
  await Promise.all(pending);
});

test('real proxy capture spills redacted large requests and responses through workers', async (t) => {
  const http = await import('node:http');
  const { ProxyEngine } = await import('../src/lib/proxy.mjs');
  const payload = JSON.stringify({ password: 'SECRET', data: 'x'.repeat(400000) });
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(payload);
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const engine = new ProxyEngine();
  t.after(() => engine.stop({ graceMs: 0 }));
  await engine.start({ port: 0 });
  await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: engine.port, method: 'POST',
      path: `http://127.0.0.1:${upstream.address().port}/worker`,
      headers: { 'content-type': 'application/json', connection: 'close' },
    }, (res) => { res.resume(); res.on('end', resolve); res.on('error', reject); });
    req.on('error', reject);
    req.end(payload);
  });
  await engine.stop({ graceMs: 0 });
  const flow = [...engine.flows.values()].find((flow) => flow.response);
  assert.ok(flow);
  for (const part of [flow.request, flow.response]) {
    assert.ok(part.body_path);
    const stored = await fs.readFile(part.body_path, 'utf8');
    assert.ok(!stored.includes('SECRET'));
    assert.equal(JSON.parse(stored).password, '[REDACTED]');
    assert.ok(part.body_redacted_at_capture);
    assert.ok(part.body_sha);
  }
  assert.equal(engine.bodyWorkers.workers.size, 0);
});
