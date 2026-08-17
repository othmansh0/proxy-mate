import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.PROXY_MCP_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-mcp-plugin-integration-'));
const { ProxyEngine } = await import('../src/lib/proxy.mjs');
const { PluginStore } = await import('../src/lib/plugin-store.mjs');
const { makeTools } = await import('../src/lib/tools.mjs');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function requestViaProxy(proxyPort, targetUrl, {
  method = 'POST', headers = { 'content-type': 'text/plain' }, body = 'original-body',
} = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port: proxyPort, method, path: targetUrl, headers,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString(),
      }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

async function createEngine(t, prefix) {
  const pluginDirectory = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  const pluginStore = new PluginStore({ directory: pluginDirectory });
  const engine = new ProxyEngine({ pluginStore, sessionId: `${prefix}-${Date.now()}` });
  await engine.start({ port: 0 });
  t.after(async () => {
    await engine.stop();
    pluginStore.dispose();
  });
  return { engine, pluginStore };
}

test('ProxyEngine applies request and response plugins to real proxied traffic', async (t) => {
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      response.writeHead(201, { 'content-type': 'application/json', 'x-upstream': 'yes' });
      response.end(JSON.stringify({
        method: request.method,
        plugin_header: request.headers['x-request-plugin'] ?? null,
        body: Buffer.concat(chunks).toString(),
      }));
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const { engine, pluginStore } = await createEngine(t, 'plugin-traffic');
  const origin = `http://127.0.0.1:${upstreamPort}`;

  await pluginStore.upsert({
    id: 'request-change', stage: 'request', enabled: true,
    source: `(input) => ({
      method: "PATCH",
      headers: { "x-request-plugin": input.request.body.text },
      body: "request-was-transformed"
    })`,
  });
  await engine.registerRule({
    rule_id: 'plugin-request-rule', type: 'plugin_transform', plugin_id: 'request-change',
    plugin_stage: 'request', url_pattern: `^${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/request$`,
  });
  const requestResult = await requestViaProxy(engine.port, `${origin}/request`);
  assert.equal(requestResult.status, 201);
  assert.deepEqual(JSON.parse(requestResult.body), {
    method: 'PATCH', plugin_header: 'original-body', body: 'request-was-transformed',
  });

  await pluginStore.upsert({
    id: 'response-change', stage: 'response', enabled: true,
    source: `(input) => ({
      status_code: 299,
      headers: { "x-response-plugin": String(input.response.status_code) },
      body: "response-was-transformed"
    })`,
  });
  await engine.registerRule({
    rule_id: 'plugin-response-rule', type: 'plugin_transform', plugin_id: 'response-change',
    plugin_stage: 'response', url_pattern: `^${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/response$`,
  });
  const responseResult = await requestViaProxy(engine.port, `${origin}/response`);
  assert.equal(responseResult.status, 299);
  assert.equal(responseResult.headers['x-response-plugin'], '201');
  assert.equal(responseResult.body, 'response-was-transformed');
});

test('ProxyEngine rejects disabled and non-live-stage plugins with coded errors', async (t) => {
  const { engine, pluginStore } = await createEngine(t, 'plugin-stage');
  await pluginStore.upsert({ id: 'disabled-request', stage: 'request', enabled: false, source: '(input) => input' });
  await assert.rejects(engine.registerRule({
    rule_id: 'disabled-plugin-rule', type: 'plugin_transform', plugin_id: 'disabled-request',
    plugin_stage: 'request', url_pattern: '^http://disabled-plugin\\.test/',
  }), (error) => error.code === 'PLUGIN_DISABLED');

  await pluginStore.upsert({ id: 'offline-only', stage: 'websocket_offline', enabled: true, source: '(input) => input' });
  await assert.rejects(engine.registerRule({
    rule_id: 'offline-plugin-rule', type: 'plugin_transform', plugin_id: 'offline-only',
    plugin_stage: 'websocket_offline', url_pattern: '^http://offline-plugin\\.test/',
  }), (error) => error.code === 'PLUGIN_STAGE_MISMATCH');
});

test('ProxyEngine records a coded diagnostic when sandbox execution fails', async (t) => {
  const upstream = http.createServer((_request, response) => response.end('should-not-complete-normally'));
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const { engine, pluginStore } = await createEngine(t, 'plugin-diagnostic');
  const origin = `http://127.0.0.1:${upstreamPort}`;
  await pluginStore.upsert({
    id: 'failing-request', stage: 'request', enabled: true,
    source: '() => { throw new Error("guest detail must not escape"); }',
  });
  await engine.registerRule({
    rule_id: 'failing-plugin-rule', type: 'plugin_transform', plugin_id: 'failing-request',
    plugin_stage: 'request', url_pattern: `^${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/failure$`,
  });

  await requestViaProxy(engine.port, `${origin}/failure`).catch(() => undefined);
  const diagnostic = engine.diagnostics.find((item) => item.kind === 'transform-plugin-error');
  assert.ok(diagnostic);
  assert.equal(diagnostic.rule_id, 'failing-plugin-rule');
  assert.equal(diagnostic.plugin_id, 'failing-request');
  assert.equal(diagnostic.code, 'TRANSFORM_EXECUTION_FAILED');
  assert.doesNotMatch(diagnostic.message, /guest detail must not escape/);
});

test('makeTools keeps live plugins off by default and gates source disclosure', async (t) => {
  const previousLiveGrant = process.env.PROXY_MCP_ENABLE_TRANSFORM_PLUGINS;
  const previousSensitiveGrant = process.env.PROXY_MCP_ALLOW_SENSITIVE;
  delete process.env.PROXY_MCP_ENABLE_TRANSFORM_PLUGINS;
  delete process.env.PROXY_MCP_ALLOW_SENSITIVE;
  t.after(() => {
    if (previousLiveGrant == null) delete process.env.PROXY_MCP_ENABLE_TRANSFORM_PLUGINS;
    else process.env.PROXY_MCP_ENABLE_TRANSFORM_PLUGINS = previousLiveGrant;
    if (previousSensitiveGrant == null) delete process.env.PROXY_MCP_ALLOW_SENSITIVE;
    else process.env.PROXY_MCP_ALLOW_SENSITIVE = previousSensitiveGrant;
  });

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-tools-gating-'));
  const pluginStore = new PluginStore({ directory });
  t.after(() => pluginStore.dispose());
  const engine = new ProxyEngine({ pluginStore, sessionId: `plugin-tools-${Date.now()}` });
  const tools = makeTools({ engine, pacServer: {}, mode: 'test' });

  await assert.rejects(tools.upsert_transform_plugin({
    plugin_id: 'live-by-default', stage: 'request', enabled: true, source: '(input) => input',
  }), (error) => error.code === 'TRANSFORM_PLUGINS_NOT_ENABLED');

  const created = await tools.upsert_transform_plugin({
    plugin_id: 'disabled-by-default', stage: 'request', source: '(input) => input',
  });
  assert.equal(created.plugin.enabled, false);
  assert.equal(created.plugin.source_redacted, true);
  await assert.rejects(tools.get_transform_plugin({
    plugin_id: 'disabled-by-default', include_source: true,
  }), (error) => error.code === 'SENSITIVE_ACCESS_REQUIRED');
});
