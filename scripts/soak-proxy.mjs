#!/usr/bin/env node
// Isolated, repeatable mixed-HTTP soak. Never touches host routing or trust.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';

const seconds = Number(process.argv[2] ?? 300);
if (!Number.isFinite(seconds) || seconds < 5 || seconds > 86400) throw new Error('Duration must be 5–86400 seconds.');
const state = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-mixed-soak-'));
process.env.PROXY_MATE_HOME = state;
const { ProxyEngine } = await import('../src/lib/proxy.mjs');
const { SessionStore } = await import('../src/lib/session-store.mjs');
const { makeTools } = await import('../src/lib/tools.mjs');
const { PacServer } = await import('../src/lib/pac.mjs');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const large = gzipSync(JSON.stringify({ payload: 'x'.repeat(80000), access_token: 'soak-secret' }));
const upstream = http.createServer((req, res) => {
  if (req.url === '/large') { res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': large.length }); res.end(large); }
  else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ source: 'upstream' })); }
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${upstream.address().port}`;
const engine = new ProxyEngine({ sessionStore: new SessionStore({ retention: { max_flows: 1000, max_bytes: 32 * 1024 * 1024, max_age_ms: 0 } }) });
const tools = makeTools({ engine, pacServer: new PacServer() });
let requests = 0, updates = 0, breakpoints = 0, failures = 0;
const samples = [];
const start = Date.now();
const end = start + seconds * 1000;
function sample() { samples.push({ elapsed_ms: Date.now() - start, rss: process.memoryUsage().rss, heap: process.memoryUsage().heapUsed, cache: engine.flowCacheBytes, queued: engine.captureQueuedBytes }); }
async function request(route) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: engine.port, path: base + route }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => { requests++; res.statusCode === 200 ? resolve(Buffer.concat(chunks)) : reject(new Error(`HTTP ${res.statusCode}`)); });
    });
    req.on('error', reject); req.setTimeout(10000, () => req.destroy(new Error('soak request timeout')));
  });
}
let sampler;
let cancelled = false;
let workers = [];
try {
  await engine.start({ port: 0 });
  await tools.mock_json_response({ rule_id: 'soak-mock', url: base + '/mock', json: { revision: 0 } });
  await tools.create_breakpoint({ rule_id: 'soak-pause', url: base + '/pause', direction: 'request', timeout_ms: 3000 });
  sample(); sampler = setInterval(sample, 5000);
  workers = [
    ...Array.from({ length: 4 }, (_, worker) => (async () => {
      let iteration = worker;
      while (!cancelled && Date.now() < end) {
        const route = iteration++ % 10 === 0 ? '/large' : iteration % 2 ? '/mock' : '/pass';
        const body = await request(route);
        if (route === '/mock') assert.equal(typeof JSON.parse(body).revision, 'number');
        await delay(100);
      }
    })()),
    (async () => { while (!cancelled && Date.now() < end) {
      await tools.patch_mock_json({ rule_id: 'soak-mock', patch: { revision: ++updates } });
      await delay(500);
    } })(),
    (async () => { while (!cancelled && Date.now() < end) {
      const response = request('/pause');
      response.catch(() => {}); // observed below; do not leave an early rejection unhandled
      let pending;
      for (let i = 0; i < 200 && !pending; i++) { pending = engine.breakpoints.listPending()[0]; if (!pending) await delay(5); }
      assert.ok(pending, 'breakpoint must be observable');
      engine.breakpoints.resolve(pending.id, { action: 'respond', response: { statusCode: 200, json: { paused: true } } });
      assert.equal(JSON.parse(await response).paused, true); breakpoints++;
      await delay(2000);
    } })(),
  ];
  await Promise.all(workers);
  await engine.stop();
  sample();
  assert.equal(engine.persistenceHealth().ok, true);
  assert.equal(engine.captureDropped, 0);
  assert.ok(samples.every((s) => s.cache <= engine.maxFlowCacheBytes && s.queued <= engine.maxCaptureQueuedBytes));
  assert.ok(Math.max(...samples.map((s) => s.rss)) < 1024 * 1024 * 1024, 'soak RSS must remain below 1 GiB');
  const before = engine.sessionId;
  await engine.start({ port: 0 });
  assert.equal(engine.sessionId, before);
  assert.ok(engine.flows.size <= 500);
} catch (error) { failures++; process.exitCode = 1; console.error(error); }
finally {
  cancelled = true;
  await Promise.allSettled(workers);
  clearInterval(sampler);
  await engine.stop();
  await engine.sessionStore.close?.();
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
  console.log(JSON.stringify({ seconds, elapsed_ms: Date.now() - start, requests, updates, breakpoints, failures, capture_dropped: engine.captureDropped, peak_rss_bytes: Math.max(...samples.map((s) => s.rss)), samples }, null, 2));
  await fs.rm(state, { recursive: true, force: true });
}
