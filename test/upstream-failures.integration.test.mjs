import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

process.env.PROXY_MATE_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-upstream-failures-'));
const { ProxyEngine } = await import('../src/lib/proxy.mjs');
const { PacServer } = await import('../src/lib/pac.mjs');
const { makeTools } = await import('../src/lib/tools.mjs');
const { MCP_TOOLS, successToolResult } = await import('../src/lib/mcp-contract.mjs');

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function captured(engine, predicate) {
  for (let index = 0; index < 200; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await Promise.all([...engine.captureWork.values()]);
    const flow = [...engine.flows.values()].find(predicate);
    if (flow) return flow;
  }
  assert.fail('Expected completed capture was not available.');
}

async function request(port, url, body = '') {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ host: '127.0.0.1', port, path: url,
      method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', connection: 'close' },
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    outgoing.once('error', reject);
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error('Fixture deadline exceeded.')));
    outgoing.end(body);
  });
}

test('proxy-generated 502 retains durable machine-readable errors and correlated diagnostics', async (t) => {
  const reserved = net.createServer();
  const unavailablePort = await listen(reserved);
  await new Promise((resolve) => reserved.close(resolve));
  const engine = new ProxyEngine({ sessionId: 'connection-refused' });
  await engine.start({ port: 0 });
  t.after(() => engine.stop());
  const tools = makeTools({ engine, pacServer: new PacServer() });
  const target = `http://127.0.0.1:${unavailablePort}/bootstrap?token=query-secret`;
  assert.equal(await request(engine.port, target, '{"password":"body-secret"}'), 502);
  const flow = await captured(engine, (item) => item.response?.statusCode === 502);
  assert.equal(flow.response.upstream_error.source, 'proxy');
  assert.equal(flow.response.upstream_error.code, 'ECONNREFUSED');
  assert.ok(flow.response.tags.includes('passthrough-error:ECONNREFUSED'));
  const diagnostics = await tools.get_diagnostics();
  const diagnostic = diagnostics.diagnostics.find((item) => item.kind === 'upstream-error');
  assert.equal(diagnostic.id, flow.id);
  assert.equal(diagnostic.code, 'ECONNREFUSED');
  assert.equal(JSON.stringify(diagnostic).includes('secret'), false);
  const detail = await tools.get_flow_detail({ flow_id: flow.id, body_mode: 'preview' });
  const output = successToolResult('get_flow_detail', {}, detail).structuredContent;
  assert.equal(MCP_TOOLS.find((item) => item.name === 'get_flow_detail').outputSchema.safeParse(output).success, true);
  assert.equal(output.data.response.upstream_error.code, 'ECONNREFUSED');
  assert.equal(JSON.stringify(output).includes('query-secret'), false);
  assert.equal(JSON.stringify(output).includes('body-secret'), false);
  assert.equal((await tools.get_flows({})).flows[0].upstream_error.code, 'ECONNREFUSED');
  await engine.stop();
  const restored = new ProxyEngine({ sessionId: 'connection-refused' });
  await restored.start({ port: 0 });
  t.after(() => restored.stop());
  const persisted = await restored.getDurableFlow(flow.id);
  assert.equal(persisted.response.upstream_error.code, 'ECONNREFUSED');
  assert.deepEqual(persisted.response.tags, flow.response.tags);
});

test('an actual upstream 502 is distinguished from a proxy connection failure', async (t) => {
  const origin = http.createServer((_request, response) => {
    response.writeHead(502);
    response.end('AggregateError');
  });
  const originPort = await listen(origin);
  t.after(() => new Promise((resolve) => origin.close(resolve)));
  const engine = new ProxyEngine({ sessionId: 'backend-502' });
  await engine.start({ port: 0 });
  t.after(() => engine.stop());
  assert.equal(await request(engine.port, `http://127.0.0.1:${originPort}/`), 502);
  const flow = await captured(engine, (item) => item.response?.statusCode === 502);
  assert.equal(flow.response.upstream_error, null);
  assert.deepEqual(flow.response.tags, []);
  assert.equal(engine.diagnostics.some((item) => item.kind === 'upstream-error'), false);
});

test('a reset after receiving an authentication POST does not replay the request', async (t) => {
  let received = 0;
  const origin = http.createServer((incoming) => {
    incoming.resume();
    incoming.once('end', () => { received += 1; incoming.socket.destroy(); });
  });
  const originPort = await listen(origin);
  t.after(() => new Promise((resolve) => origin.close(resolve)));
  const engine = new ProxyEngine({ sessionId: 'single-post' });
  await engine.start({ port: 0 });
  t.after(() => engine.stop());
  assert.equal(await request(engine.port, `http://127.0.0.1:${originPort}/token`, '{"password":"body-secret"}'), 502);
  const flow = await captured(engine, (item) => item.response?.statusCode === 502);
  assert.equal(flow.response.upstream_error.code, 'ECONNRESET');
  assert.equal(received, 1);
});

test('untrusted upstream TLS is rejected and surfaced without disabling certificate verification', async (t) => {
  const engine = new ProxyEngine({ sessionId: 'upstream-tls' });
  await engine.start({ port: 0 });
  t.after(() => engine.stop());
  const origin = https.createServer({ key: await fs.readFile(engine.caKeyPath), cert: await fs.readFile(engine.caCertPath) }, (_request, response) => {
    assert.fail('Untrusted upstream TLS must not reach HTTP handling.');
    response.end();
  });
  const originPort = await listen(origin);
  t.after(() => new Promise((resolve) => origin.close(resolve)));
  assert.equal(await request(engine.port, `https://127.0.0.1:${originPort}/`), 502);
  const flow = await captured(engine, (item) => item.response?.statusCode === 502);
  assert.equal(flow.response.upstream_error.code, 'DEPTH_ZERO_SELF_SIGNED_CERT');
  assert.ok(engine.diagnostics.some((item) => item.kind === 'upstream-error' && item.id === flow.id));
});
