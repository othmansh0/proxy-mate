import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import * as mockttp from 'mockttp';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const state = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-recovery-test-'));
process.env.PROXY_MCP_HOME = state;
const { ProxyEngine, ensureCA } = await import('../src/lib/proxy.mjs');
const { composeHttpRequest } = await import('../src/lib/request-tools.mjs');
const { flowBodyToMockBody, storeFlowBody } = await import('../src/lib/bodies.mjs');
const { makeTools } = await import('../src/lib/tools.mjs');
const { PacServer } = await import('../src/lib/pac.mjs');
after(() => fs.rm(state, { recursive: true, force: true }));

test('sustained RSS pressure runs cleanup before a supervised restart', async () => {
  const runtime = new URL('../src/lib/runtime.mjs', import.meta.url).href;
  const source = `import { installShutdownHandlers } from ${JSON.stringify(runtime)};
    process.memoryUsage = () => ({ rss: 2 * 1024 * 1024 * 1024 });
    installShutdownHandlers(async () => { console.log('cleanup-completed'); });
    setInterval(() => {}, 1000);`;
  await assert.rejects(promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, PROXY_MCP_MAX_RSS_MB: '128' }, timeout: 15000,
  }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /sustained memory pressure/);
    assert.match(error.stdout, /cleanup-completed/);
    return true;
  });
});

test('startup completes an interrupted CA transaction using the intended pair', async () => {
  const { keyPath, certPath } = await ensureCA();
  const pair = await mockttp.generateCACertificate({ subject: { commonName: 'transaction fixture' } });
  await fs.writeFile(path.join(state, 'ca/rotation.pending.json'), JSON.stringify(pair), { mode: 0o600 });
  await fs.writeFile(keyPath, pair.key);
  await ensureCA();
  const cert = new crypto.X509Certificate(await fs.readFile(certPath));
  assert.ok(cert.checkPrivateKey(crypto.createPrivateKey(await fs.readFile(keyPath))));
  assert.equal(cert.fingerprint256, new crypto.X509Certificate(pair.cert).fingerprint256);
  await assert.rejects(fs.access(path.join(state, 'ca/rotation.pending.json')), { code: 'ENOENT' });
  const before = await fs.readFile(certPath, 'utf8');
  await fs.writeFile(path.join(state, 'ca/rotation.pending.json'), '{}');
  await assert.rejects(ensureCA(), { code: 'CA_TRANSACTION_INVALID' });
  assert.equal(await fs.readFile(certPath, 'utf8'), before);
  await fs.unlink(path.join(state, 'ca/rotation.pending.json'));
});

test('session hydration uses bounded pages and a byte-limited live cache', async (t) => {
  let calls = 0;
  const store = {
    ensureSession: async () => {},
    listFlows: async ({ cursor, limit }) => {
      calls++; assert.ok(limit <= 50);
      const start = Number(cursor ?? 0), end = Math.min(start + limit, 2000);
      return { flows: Array.from({ length: end - start }, (_, i) => ({ id: String(start + i), request: { body_inline: 'x'.repeat(4000) } })), next_cursor: end < 2000 ? String(end) : null };
    },
  };
  const engine = new ProxyEngine({ sessionStore: store });
  engine.maxFlowCacheBytes = 128 * 1024;
  t.after(() => engine.stop());
  await engine.start({ port: 0 });
  assert.equal(calls, 40);
  assert.ok(engine.flows.size < 20);
  assert.ok(engine.flows.has('1999'));
  assert.ok(engine.flowCacheBytes <= engine.maxFlowCacheBytes);
});

test('composed responses are cancelled at the preview cap instead of buffered indefinitely', async (t) => {
  const upstream = http.createServer((_req, res) => { res.setHeader('content-type', 'application/octet-stream'); res.end(Buffer.alloc(2 * 1024 * 1024, 'a')); });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); return new Promise((resolve) => upstream.close(resolve)); });
  const result = await composeHttpRequest({ url: `http://127.0.0.1:${upstream.address().port}/large` });
  assert.equal(result.response.body_returned_bytes, 65536);
  assert.equal(result.response.body_truncated, true);
  assert.equal(result.response.body_size_exact, false);
});

test('spilled request replay is not empty, and missing mock source files fail visibly', async (t) => {
  const upstream = http.createServer((req, res) => {
    let count = 0; req.on('data', (chunk) => { count += chunk.length; });
    req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ count, encoding: req.headers['content-encoding'] ?? null })); });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); return new Promise((resolve) => upstream.close(resolve)); });
  const body = JSON.stringify({ data: 'x'.repeat(80000) });
  const stored = await storeFlowBody(Buffer.from(body), 'spilled-replay', 'req');
  const engine = new ProxyEngine();
  engine.flows.set('spilled-replay', { id: 'spilled-replay', request: { method: 'POST', url: `http://127.0.0.1:${upstream.address().port}/echo`, headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body_path: stored.path, body_size: stored.size } });
  const tools = makeTools({ engine, pacServer: new PacServer() });
  const result = await tools.repeat_flow({ flow_id: 'spilled-replay' });
  assert.deepEqual(JSON.parse(result.response.body), { count: Buffer.byteLength(body), encoding: null });
  await assert.rejects(flowBodyToMockBody({ ruleId: 'missing', srcPath: path.join(state, 'missing.bin') }), { code: 'ENOENT' });
});

test('an oversized chunked response cannot silently become an empty mock', async (t) => {
  const upstream = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('x'.repeat(4096)); res.end(); });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const engine = new ProxyEngine();
  t.after(async () => { await engine.stop(); upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); });
  await engine.start({ port: 0, maxBodySize: 1024 });
  await new Promise((resolve, reject) => { const req = http.get({ host: '127.0.0.1', port: engine.port, path: `http://127.0.0.1:${upstream.address().port}/chunked` }, (res) => { res.resume(); res.on('end', resolve); }); req.on('error', reject); });
  let flow;
  for (let i = 0; i < 100 && !flow; i++) { flow = [...engine.flows.values()].find((f) => f.response); if (!flow) await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.match(flow.response.body_omitted, /chunked/);
  await assert.rejects(makeTools({ engine, pacServer: new PacServer() }).capture_to_mock({ flow_id: flow.id }), { code: 'BODY_UNAVAILABLE' });
});
