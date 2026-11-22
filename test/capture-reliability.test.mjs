import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';

const state = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-capture-reliability-'));
process.env.PROXYFAN_HOME = state;
const { ProxyEngine, ensureCA, rotateCA, validateCA } = await import('../src/lib/proxy.mjs');
const { makeTools } = await import('../src/lib/tools.mjs');
const { PacServer } = await import('../src/lib/pac.mjs');
const { callDaemon, ControlServer } = await import('../src/lib/control.mjs');
after(() => fs.rm(state, { recursive: true, force: true }));

async function fetchThrough(port, url) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: url }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

test('compressed JSON is decoded, redacted and reusable as a mock; oversized decoding is omitted', async (t) => {
  const json = JSON.stringify({ hello: 'world', access_token: 'do-not-persist-me' });
  const encoders = { gzip: gzipSync, deflate: deflateSync, br: brotliCompressSync };
  const upstream = http.createServer((req, res) => {
    const encoding = req.url.slice(1);
    const body = encoding === 'bomb' ? gzipSync(Buffer.alloc(65536, 'x')) : encoders[encoding](json);
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': encoding === 'bomb' ? 'gzip' : encoding, 'content-length': body.length });
    res.end(body);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); return new Promise((resolve) => upstream.close(resolve)); });
  const engine = new ProxyEngine();
  t.after(() => engine.stop());
  await engine.start({ port: 0, maxBodySize: 1024 });
  const tools = makeTools({ engine, pacServer: new PacServer() });
  for (const encoding of ['gzip', 'deflate', 'br', 'bomb']) {
    const url = `http://127.0.0.1:${upstream.address().port}/${encoding}`;
    await fetchThrough(engine.port, url);
    let flow;
    for (let attempt = 0; attempt < 100; attempt++) {
      flow = [...engine.flows.values()].find((f) => f.request?.url === url && f.response);
      if (flow) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(flow?.response);
    if (encoding === 'bomb') {
      assert.match(flow.response.body_omitted, /capture limit/);
      await assert.rejects(tools.capture_to_mock({ flow_id: flow.id }), { code: 'BODY_UNAVAILABLE' });
    } else {
      assert.equal(flow.response.body_decoded, true);
      assert.equal(JSON.parse(flow.response.body_inline).hello, 'world');
      assert.ok(!flow.response.body_inline.includes('do-not-persist-me'));
      await tools.capture_to_mock({ flow_id: flow.id });
      assert.equal(JSON.parse((await fetchThrough(engine.port, url)).toString()).hello, 'world');
    }
  }
});

test('malformed JSON RPC envelopes reject without an uncaught exception', async (t) => {
  const server = http.createServer((_req, res) => res.end('null'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await assert.rejects(callDaemon({ controlUrl: `http://127.0.0.1:${server.address().port}`, token: 'test', tool: 'get_proxy_status' }), { code: 'INVALID_DAEMON_RESPONSE' });
});

test('explicit CA rotation repairs a partial pair and concurrent ensure reads the new valid pair', async () => {
  const { keyPath, certPath } = await ensureCA();
  await fs.unlink(keyPath);
  await assert.rejects(ensureCA(), { code: 'CA_INCOMPLETE' });
  const result = await rotateCA();
  assert.equal(result.rotated, true);
  await Promise.all([ensureCA(), ensureCA()]);
  const cert = await validateCA(keyPath, certPath);
  assert.equal(cert.fingerprint256.replaceAll(':', '').toLowerCase(), result.fingerprint_sha256);
});

test('non-serializable tool errors do not escape the RPC error boundary', async (t) => {
  const details = { value: 1n };
  details.self = details;
  const control = new ControlServer({ port: 0, tools: {
    fixture_error: async () => { throw Object.assign(new Error('fixture'), { details }); },
    fixture_ok: async () => ({ healthy: true }),
  } });
  await control.start();
  t.after(() => control.stop());
  const connection = { controlUrl: `http://127.0.0.1:${control.port}`, token: control.token };
  await assert.rejects(callDaemon({ ...connection, tool: 'fixture_error' }), /non-serializable/);
  assert.deepEqual(await callDaemon({ ...connection, tool: 'fixture_ok' }), { healthy: true });
});

test('a historical-session lookup cannot use a different active-session cache', async () => {
  const historical = { id: 'shared-id', session_id: 'historical' };
  const engine = new ProxyEngine({ sessionStore: { getFlow: async () => historical } });
  engine.flows.set('shared-id', { id: 'shared-id', session_id: 'default' });
  assert.equal((await engine.getDurableFlow('shared-id')).session_id, 'default');
  assert.equal(await engine.getDurableFlow('shared-id', 'historical'), historical);
});
