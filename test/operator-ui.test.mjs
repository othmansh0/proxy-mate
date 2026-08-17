import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';

import { OperatorUiServer } from '../src/lib/operator-ui.mjs';

function request(port, path, { token, host, origin } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'GET',
      headers: {
        Host: host ?? `127.0.0.1:${port}`,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(origin !== undefined ? { Origin: origin } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.once('error', reject);
    req.end();
  });
}

async function withUi(options, run) {
  const ui = new OperatorUiServer({ port: 0, ...options });
  const started = await ui.start();
  try { await run(ui, started); } finally { await ui.stop(); }
}

test('operator UI is opt-in, loopback-only, token protected, and sends a strict page CSP', async () => {
  const ui = new OperatorUiServer();
  assert.equal(ui.status.running, false);
  const started = await ui.start();
  try {
    assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(started.url.includes(started.token), false);
    assert.match(started.token, /^[A-Za-z0-9_-]{40,}$/);
    const page = await request(ui.port, '/');
    assert.equal(page.status, 200);
    assert.ok(Buffer.byteLength(page.body) <= 4096);
    assert.equal(page.body.includes(started.token), false);
    assert.match(page.headers['content-security-policy'], /default-src 'none'/);
    assert.match(page.headers['content-security-policy'], /connect-src 'self'/);
    assert.equal(page.headers['cache-control'], 'no-store, max-age=0');
    assert.equal((await request(ui.port, '/api/status')).status, 401);
    assert.equal((await request(ui.port, '/api/status', { token: started.token })).status, 200);
  } finally { await ui.stop(); }
  assert.equal(ui.status.running, false);
});

test('operator UI rejects untrusted Host and Origin headers', async () => {
  await withUi({}, async (ui, started) => {
    assert.equal((await request(ui.port, '/api/health', { token: started.token, host: 'localhost' })).status, 421);
    assert.equal((await request(ui.port, '/api/health', { token: started.token, origin: 'http://localhost:3000' })).status, 403);
    assert.equal((await request(ui.port, '/api/health', { token: started.token, origin: `http://127.0.0.1:${ui.port}` })).status, 200);
  });
});

test('operator UI projects flow and rule summaries across the redaction boundary', async () => {
  await withUi({ providers: {
    recentFlows: async () => [{
      id: 'flow-1', request: { method: 'POST', url: 'https://api.example.test/orders?access_token=secret', headers: { authorization: 'Bearer leaked' }, body: '{"password":"leaked"}' },
      response: { statusCode: 201, headers: { 'set-cookie': 'leaked' }, body: 'leaked' }, duration_ms: 42,
    }],
    rules: async () => [{ rule_id: 'rule-1', name: 'Block ads', type: 'blacklist', enabled: true, priority: 4, headers: { authorization: 'leaked' }, body: 'leaked' }],
  } }, async (ui, started) => {
    const flows = JSON.parse((await request(ui.port, '/api/flows', { token: started.token })).body);
    assert.deepEqual(flows.flows[0], { id: 'flow-1', method: 'POST', url: 'https://api.example.test/orders', status: 201, duration_ms: 42, timestamp: null });
    const serialized = JSON.stringify(flows);
    assert.equal(serialized.includes('leaked'), false);
    assert.equal(serialized.includes('headers'), false);
    assert.equal(serialized.includes('body'), false);
    const rules = JSON.parse((await request(ui.port, '/api/rules', { token: started.token })).body);
    assert.deepEqual(rules.rules[0], { id: 'rule-1', name: 'Block ads', type: 'blacklist', enabled: true, priority: 4 });
  });
});

test('operator UI enforces bounded rate and provider concurrency, then shuts down cleanly', async () => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  await withUi({
    rateLimit: 20,
    maxConcurrentRequests: 1,
    providers: { status: async () => { await wait; return { running: true }; } },
  }, async (ui, started) => {
    const first = request(ui.port, '/api/status', { token: started.token });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await request(ui.port, '/api/status', { token: started.token })).status, 503);
    release();
    assert.equal((await first).status, 200);
  });

  await withUi({ rateLimit: 1, rateWindowMs: 1_000 }, async (ui, started) => {
    assert.equal((await request(ui.port, '/', { token: started.token })).status, 200);
    const limited = await request(ui.port, '/', { token: started.token });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers['cache-control'], 'no-store, max-age=0');
  });
});
