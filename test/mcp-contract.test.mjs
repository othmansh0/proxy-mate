import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MCP_RESOURCE_URIS, MCP_TOOLS, errorToolResult, registerMcpPrompts, registerMcpResourceSubscriptions, registerMcpResources, registerMcpTools,
  successToolResult, toolOutputSchema,
} from '../src/lib/mcp-contract.mjs';
import { makeTools } from '../src/lib/tools.mjs';
import { ProxyEngine } from '../src/lib/proxy.mjs';
import { PacServer } from '../src/lib/pac.mjs';

test('registry has unique, fully annotated tool contracts', () => {
  const names = MCP_TOOLS.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length);
  for (const tool of MCP_TOOLS) {
    assert.ok(tool.outputSchema, `${tool.name} missing output schema`);
    assert.equal(typeof tool.title, 'string', `${tool.name} missing title`);
    assert.equal(typeof tool._meta?.['proxy-mcp/group'], 'string', `${tool.name} missing group metadata`);
    for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      assert.equal(typeof tool.annotations[hint], 'boolean', `${tool.name} missing ${hint}`);
    }
  }
  const implemented = Object.keys(makeTools({ engine: new ProxyEngine(), pacServer: new PacServer() })).sort();
  assert.deepEqual(names.toSorted(), implemented, 'MCP registry and dispatch implementations diverged');
});

test('high-traffic tools validate their canonical output payloads while retaining legacy aliases', () => {
  const status = successToolResult('get_proxy_status', {}, {
    running: true, port: 8080, recording: true, domains: ['api.example.test'], legacy_field: 'kept',
  }).structuredContent;
  const statusTool = MCP_TOOLS.find((tool) => tool.name === 'get_proxy_status');
  assert.equal(statusTool.outputSchema.safeParse(status).success, true);
  assert.equal(status.legacy_field, 'kept');
  assert.equal(statusTool.outputSchema.safeParse({ ...status, data: { running: 'yes' } }).success, false);

  const flows = successToolResult('get_flows', {}, {
    flows: [{ id: 'f-1', request: { method: 'GET', url: 'https://example.test' }, response: { statusCode: 200 } }],
    total: 1, has_more: false,
  }).structuredContent;
  assert.equal(MCP_TOOLS.find((tool) => tool.name === 'get_flows').outputSchema.safeParse(flows).success, true);

  const rules = successToolResult('list_rules', {}, { rules: [{ rule_id: 'mock-1', type: 'map_local', enabled: true, priority: 10 }] }).structuredContent;
  assert.equal(MCP_TOOLS.find((tool) => tool.name === 'list_rules').outputSchema.safeParse(rules).success, true);
});

test('pending breakpoint contracts explicitly gate sensitive previews', () => {
  for (const name of ['list_pending_breakpoints', 'get_pending_breakpoint']) {
    const definition = MCP_TOOLS.find((tool) => tool.name === name);
    assert.equal(definition.inputSchema.include_sensitive.safeParse(true).success, true);
  }
});

test('success and error results follow the stable envelope without verbose JSON text', () => {
  const success = successToolResult('get_version', {}, { name: 'proxy-mcp', version: 'test', mode: 'unit' });
  assert.equal(toolOutputSchema.safeParse(success.structuredContent).success, true);
  assert.equal(success.structuredContent.data.version, 'test');
  assert.equal(success.structuredContent.version, 'test'); // 1.x compatibility alias
  assert.equal(success.content[0].text.includes('{'), false);

  const flow = successToolResult('get_flow_detail', {}, {
    id: 'flow/1', request: { body_path: '/private/body', body_size: 10 }, response: null,
  });
  assert.equal(flow.structuredContent.data.request.body_path, undefined);
  assert.equal(flow.structuredContent.data.request.body_resource_uri, 'proxy-mcp://flows/flow%2F1/bodies/request');

  const failure = new Error('try again');
  failure.code = 'TEMPORARY_FAILURE';
  failure.retryable = true;
  failure.recovery = 'Retry the operation';
  failure.details = { phase: 'preflight' };
  const result = errorToolResult('test_tool', {}, failure);
  assert.equal(toolOutputSchema.safeParse(result.structuredContent).success, true);
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent.error, {
    code: 'TEMPORARY_FAILURE', message: 'try again', retryable: true,
    recovery: ['Retry the operation'], details: { phase: 'preflight' },
  });
});

test('last-boundary redaction covers nested credentials without breaking onboarding URLs', () => {
  const portalUrl = 'http://192.0.2.1:8123/random-tokenized-path/cert.der';
  const value = {
    headers: { authorization: 'Bearer abcdefghijklmnop', cookie: 'sid=secret' },
    nested: { password: 'secret', body: '{"access_token":"secret","safe":"value"}' },
    to_url: 'https://api.example.test/v1?api_key=secret&safe=value',
    portal_urls: [portalUrl],
  };
  const safe = successToolResult('example', {}, value).structuredContent.data;
  assert.equal(safe.headers.authorization, '[REDACTED]');
  assert.equal(safe.headers.cookie, '[REDACTED]');
  assert.equal(safe.nested.password, '[REDACTED]');
  assert.deepEqual(JSON.parse(safe.nested.body), { access_token: '[REDACTED]', safe: 'value' });
  const redactedUrl = new URL(safe.to_url);
  assert.equal(redactedUrl.searchParams.get('api_key'), '[REDACTED]');
  assert.equal(redactedUrl.searchParams.get('safe'), 'value');
  assert.equal(safe.portal_urls[0], portalUrl);

  const granted = successToolResult('example', { include_sensitive: true }, value).structuredContent.data;
  assert.equal(granted.headers.authorization, 'Bearer abcdefghijklmnop');

  const error = new Error('upstream sent Basic YWxpY2U6c2VjcmV0');
  error.details = { token: 'secret', note: 'Bearer abcdefghijklmnop' };
  error.recovery = ['Remove Authorization: Bearer abcdefghijklmnop'];
  const failed = errorToolResult('example', {}, error).structuredContent.error;
  assert.equal(failed.message, 'upstream sent Basic [REDACTED]');
  assert.deepEqual(failed.details, { token: '[REDACTED]', note: 'Bearer [REDACTED]' });
  assert.deepEqual(failed.recovery, ['Remove Authorization: Bearer [REDACTED]']);
});

test('long-running registry handlers emit logs and progress without exposing arguments', async () => {
  const registered = new Map();
  const logs = [];
  const notifications = [];
  const mcp = {
    registerTool(name, config, callback) { registered.set(name, { config, callback }); },
    async sendLoggingMessage(message) { logs.push(message); },
  };
  registerMcpTools(mcp, async (name) => ({ status: `${name}-done` }));

  const entry = registered.get('setup_simulator_certificate');
  const result = await entry.callback(
    { developer_dir: '/Applications/Xcode.app' },
    {
      _meta: { progressToken: 'progress-1' },
      signal: new AbortController().signal,
      async sendNotification(notification) { notifications.push(notification); },
    },
  );
  assert.equal(result.structuredContent.ok, true);
  assert.deepEqual(notifications.map((item) => item.params.progress), [0, 1]);
  assert.deepEqual(logs.map((item) => item.data.event), ['tool_started', 'tool_completed']);
  assert.equal(JSON.stringify(logs).includes('/Applications/Xcode.app'), false);

  const cancelled = new AbortController();
  cancelled.abort();
  const cancelledResult = await entry.callback({}, {
    signal: cancelled.signal,
    async sendNotification() {},
  });
  assert.equal(cancelledResult.isError, true);
  assert.equal(cancelledResult.structuredContent.error.code, 'REQUEST_CANCELLED');
  assert.equal(cancelledResult.structuredContent.error.retryable, true);
});

test('resources expose status, redacted flow detail, and body content through dispatch', async () => {
  const resources = [];
  const calls = [];
  const mcp = {
    registerResource(name, uriOrTemplate, config, callback) {
      resources.push({ name, uriOrTemplate, config, callback });
    },
  };
  registerMcpResources(mcp, async (name, args) => {
    calls.push({ name, args });
    if (name === 'get_proxy_status') return { running: false };
    if (name === 'get_extended_capabilities') return { websocket_engine: { live_message_injection: false } };
    return {
      id: args.flow_id,
      request: { headers: { 'content-type': 'application/json' }, body_inline: '{"token":"[REDACTED]"}' },
      response: { headers: { 'content-type': 'text/plain' }, body_inline: 'ok' },
    };
  });

  assert.deepEqual(resources.map((resource) => resource.name), [
    'proxy-status', 'proxy-capabilities', 'flow-detail', 'flow-body', 'session-flow-detail', 'session-flow-body',
  ]);
  const status = await resources[0].callback(new URL('proxy-mcp://status'));
  assert.equal(JSON.parse(status.contents[0].text).running, false);
  const capabilities = await resources[1].callback(new URL('proxy-mcp://capabilities'));
  assert.equal(JSON.parse(capabilities.contents[0].text).websocket_engine.live_message_injection, false);
  const detail = await resources[2].callback(new URL('proxy-mcp://flows/f-1'), { flow_id: 'f-1' });
  assert.equal(JSON.parse(detail.contents[0].text).id, 'f-1');
  const body = await resources[3].callback(new URL('proxy-mcp://flows/f-1/bodies/request'), { flow_id: 'f-1', kind: 'request' });
  assert.equal(body.contents[0].text, '{"token":"[REDACTED]"}');
  assert.equal(calls.every((call) => call.args?.include_sensitive !== true), true);
});

test('workflow prompts register concise, argument-aware MCP messages', () => {
  const prompts = new Map();
  registerMcpPrompts({
    registerPrompt(name, config, callback) { prompts.set(name, { config, callback }); },
  });
  assert.deepEqual([...prompts.keys()], ['diagnose-capture', 'mock-flow', 'compare-regression', 'security-review', 'set-up-capture-client']);
  assert.equal(prompts.get('diagnose-capture').config.argsSchema.hostname.safeParse('api.example.test').success, true);
  assert.match(prompts.get('mock-flow').callback({ flow_id: 'f-42' }).messages[0].content.text, /get_flow_detail/);
  assert.match(prompts.get('compare-regression').callback({ left_flow_id: 'before', right_flow_id: 'after' }).messages[0].content.text, /compare_flows/);
  assert.match(prompts.get('security-review').callback({}).messages[0].content.text, /include_sensitive/);
  assert.match(prompts.get('set-up-capture-client').callback({ adapter_id: 'docker' }).messages[0].content.text, /preflight_capture_adapter/);
});

test('resource subscription helper tracks status and live-flow subscribers before notifying', async () => {
  const handlers = [];
  const updates = [];
  const subscriptions = registerMcpResourceSubscriptions({
    server: {
      registerCapabilities(capabilities) { assert.deepEqual(capabilities, { resources: { subscribe: true } }); },
      setRequestHandler(schema, callback) { handlers.push({ schema, callback }); },
      async sendResourceUpdated(params) { updates.push(params); },
    },
  });
  const handlerFor = (method) => handlers.find(({ schema }) => schema.safeParse({ method, params: { uri: MCP_RESOURCE_URIS.status } }).success).callback;
  const subscribe = handlerFor('resources/subscribe');
  const unsubscribe = handlerFor('resources/unsubscribe');

  assert.equal(await subscriptions.notifyStatus(), false);
  await subscribe({ params: { uri: MCP_RESOURCE_URIS.status } });
  assert.equal(subscriptions.isSubscribed(MCP_RESOURCE_URIS.status), true);
  assert.equal(await subscriptions.notifyStatus(), true);

  const flowUri = 'proxy-mcp://flows/f-42';
  await subscribe({ params: { uri: flowUri } });
  assert.equal(await subscriptions.notifyLiveFlow('f-42'), true);
  await unsubscribe({ params: { uri: flowUri } });
  assert.equal(await subscriptions.notifyLiveFlow('f-42'), false);
  await assert.rejects(
    subscribe({ params: { uri: 'proxy-mcp://sessions/s-1/flows/f-1' } }),
    { code: 'RESOURCE_NOT_SUBSCRIBABLE' },
  );
  assert.deepEqual(updates, [
    { uri: MCP_RESOURCE_URIS.status },
    { uri: flowUri },
  ]);
});
