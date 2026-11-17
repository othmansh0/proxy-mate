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
    assert.equal(typeof tool._meta?.['proxy-mate/group'], 'string', `${tool.name} missing group metadata`);
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

test('captured headers preserve repeated values and redact sensitive arrays', () => {
  const detail = successToolResult('get_flow_detail', {}, {
    id: 'repeated-headers',
    request: { headers: { accept: ['application/json', 'text/plain'], authorization: ['Bearer secret'] } },
    response: { statusCode: 200, headers: {
      'content-type': 'application/json',
      'x-env-type': ['staging', 'staging'],
      'set-cookie': ['session=secret', 'token=private'],
    } },
  }).structuredContent;
  const schema = MCP_TOOLS.find((tool) => tool.name === 'get_flow_detail').outputSchema;
  assert.equal(schema.safeParse(detail).success, true);
  assert.deepEqual(detail.data.request.headers.accept, ['application/json', 'text/plain']);
  assert.deepEqual(detail.data.response.headers['x-env-type'], ['staging', 'staging']);
  assert.equal(detail.data.request.headers.authorization, '[REDACTED]');
  assert.equal(detail.data.response.headers['set-cookie'], '[REDACTED]');
  assert.equal(JSON.stringify(detail).includes('secret'), false);
  for (const value of [42, null, ['valid', 42], { value: 'invalid' }]) {
    assert.equal(schema.safeParse({ ...detail, data: {
      ...detail.data, response: { headers: { invalid: value } },
    } }).success, false);
  }
  const input = MCP_TOOLS.find((tool) => tool.name === 'mock_json_response').inputSchema.headers;
  assert.equal(input.safeParse({ 'x-env-type': ['staging'] }).success, false);
});

test('pending breakpoint contracts explicitly gate sensitive previews', () => {
  for (const name of ['list_pending_breakpoints', 'get_pending_breakpoint']) {
    const definition = MCP_TOOLS.find((tool) => tool.name === name);
    assert.equal(definition.inputSchema.include_sensitive.safeParse(true).success, true);
  }
});

test('success and error results follow the stable envelope without verbose JSON text', () => {
  const success = successToolResult('get_version', {}, { name: 'proxy-mate', version: 'test', mode: 'unit' });
  assert.equal(toolOutputSchema.safeParse(success.structuredContent).success, true);
  assert.equal(success.structuredContent.data.version, 'test');
  assert.equal(success.structuredContent.version, 'test'); // 1.x compatibility alias
  assert.equal(success.content[0].text.includes('{'), false);

  const flow = successToolResult('get_flow_detail', {}, {
    id: 'flow/1', request: { body_path: '/private/body', body_size: 10 }, response: null,
  });
  assert.equal(flow.structuredContent.data.request.body_path, undefined);
  assert.equal(flow.structuredContent.data.request.body_resource_uri, 'proxy-mate://flows/flow%2F1/bodies/request');

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

  assert.deepEqual(resources.slice(0, 6).map((resource) => resource.name), [
    'proxy-status', 'proxy-capabilities', 'flow-detail', 'flow-body', 'session-flow-detail', 'session-flow-body',
  ]);
  const status = await resources[0].callback(new URL('proxy-mate://status'));
  assert.equal(JSON.parse(status.contents[0].text).running, false);
  const capabilities = await resources[1].callback(new URL('proxy-mate://capabilities'));
  assert.equal(JSON.parse(capabilities.contents[0].text).websocket_engine.live_message_injection, false);
  const detail = await resources[2].callback(new URL('proxy-mate://flows/f-1'), { flow_id: 'f-1' });
  assert.equal(JSON.parse(detail.contents[0].text).id, 'f-1');
  const body = await resources[3].callback(new URL('proxy-mate://flows/f-1/bodies/request'), { flow_id: 'f-1', kind: 'request' });
  assert.equal(body.contents[0].text, '{"token":"[REDACTED]"}');
  const legacyDetail = await resources.find((resource) => resource.name === 'flow-detail-legacy')
    .callback(new URL('proxy-mcp://flows/f-1'), { flow_id: 'f-1' });
  assert.equal(legacyDetail.contents[0].uri, 'proxy-mcp://flows/f-1');
  assert.equal(calls.every((call) => call.args?.include_sensitive !== true), true);
});

test('workflow prompts register concise, argument-aware MCP messages', () => {
  const prompts = new Map();
  registerMcpPrompts({
    registerPrompt(name, config, callback) { prompts.set(name, { config, callback }); },
  });
  assert.deepEqual([...prompts.keys()], ['set-up-capture', 'debug-ios-api', 'diagnose-capture', 'mock-flow', 'compare-regression', 'security-review', 'set-up-capture-client']);
  assert.match(prompts.get('set-up-capture').callback({}).messages[0].content.text, /start_app_capture/);
  const workflow = prompts.get('debug-ios-api').callback({ url: 'https://api.example.test/users', task_id: 'login-test' }).messages[0].content.text;
  assert.match(workflow, /mock_json_response/);
  assert.match(workflow, /patch_mock_json/);
  assert.match(workflow, /login-test/);
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

  const flowUri = 'proxy-mate://flows/f-42';
  await subscribe({ params: { uri: flowUri } });
  assert.equal(await subscriptions.notifyLiveFlow('f-42'), true);
  await unsubscribe({ params: { uri: flowUri } });
  assert.equal(await subscriptions.notifyLiveFlow('f-42'), false);
  await assert.rejects(
    subscribe({ params: { uri: 'proxy-mate://sessions/s-1/flows/f-1' } }),
    { code: 'RESOURCE_NOT_SUBSCRIBABLE' },
  );
  assert.deepEqual(updates, [
    { uri: MCP_RESOURCE_URIS.status },
    { uri: flowUri },
  ]);
  await subscribe({ params: { uri: 'proxy-mcp://status' } });
  await subscribe({ params: { uri: 'proxy-mcp://flows/old-flow/bodies/response' } });
  await subscriptions.notifyStatus();
  await subscriptions.notifyLiveFlow('old-flow');
  assert.deepEqual(updates.slice(-3), [
    { uri: MCP_RESOURCE_URIS.status }, { uri: 'proxy-mcp://status' },
    { uri: 'proxy-mcp://flows/old-flow/bodies/response' },
  ]);
});

test('every match_query in the registry keeps a prototype-shaped key the caller sent', () => {
  // zod 4's z.record skips a '__proto__' key outright, and MCP arguments come
  // from JSON.parse, which makes it an own enumerable property. A rule that
  // quietly loses a query constraint matches more than the caller asked for, so
  // this holds for every tool that accepts one, not just the ones with a test.
  const sites = MCP_TOOLS.filter((tool) => tool.inputSchema?.match_query);
  assert.ok(sites.length >= 7, `expected the match_query surface, found ${sites.length}`);
  for (const tool of sites) {
    const schema = tool.inputSchema.match_query;
    const parsed = schema.parse(JSON.parse('{"__proto__":"evil","b":"1"}'));
    assert.deepEqual(Object.keys(parsed), ['__proto__', 'b'], tool.name);
    assert.equal(parsed['__proto__'], 'evil', tool.name);
    // Null prototype, so re-assigning the key downstream cannot lose it either.
    assert.equal(Object.getPrototypeOf(parsed), null, tool.name);
    // The shape the record it replaced accepted, and only that shape.
    assert.equal(schema.safeParse({ b: ['1', '2'] }).success, true, tool.name);
    assert.equal(schema.safeParse(undefined).success, true, tool.name);
    for (const bad of ['a=1', ['a'], 42, null, { a: 1 }, { a: [1] }]) {
      assert.equal(schema.safeParse(bad).success, false, `${tool.name}: ${JSON.stringify(bad)}`);
    }
  }
  assert.equal({}.evil, undefined);
});

test('every match_headers in the registry keeps a prototype-shaped key the caller sent', () => {
  // The same z.record hole one field over: mockttp's HeaderMatcher is _.isMatch
  // too, so a dropped header key widens the rule exactly as a dropped query key
  // does — and a match_headers that loses its only key is {}, which matches
  // every request on the path.
  const sites = MCP_TOOLS.filter((tool) => tool.inputSchema?.match_headers);
  assert.ok(sites.length >= 3, `expected the match_headers surface, found ${sites.length}`);
  for (const tool of sites) {
    const schema = tool.inputSchema.match_headers;
    const parsed = schema.parse(JSON.parse('{"__proto__":"evil","x-api-key":"k"}'));
    assert.deepEqual(Object.keys(parsed), ['__proto__', 'x-api-key'], tool.name);
    assert.equal(parsed['__proto__'], 'evil', tool.name);
    assert.equal(Object.getPrototypeOf(parsed), null, tool.name);
    // The shape the record it replaced accepted, and only that shape: header
    // values stay strings, unlike match_query's string-or-array.
    assert.equal(schema.safeParse({ 'x-api-key': 'k' }).success, true, tool.name);
    assert.equal(schema.safeParse(undefined).success, true, tool.name);
    for (const bad of ['a: 1', ['a'], 42, null, { a: 1 }, { a: ['k'] }]) {
      assert.equal(schema.safeParse(bad).success, false, `${tool.name}: ${JSON.stringify(bad)}`);
    }
  }
  assert.equal({}.evil, undefined);
});

test('routing contracts declare claims, loss reasons and warnings for every tool', () => {
  const claim = { claim_id: 'claim-1', client_id: 'client-a', task_id: null,
    domains: ['a.test'], expires_at: new Date().toISOString(), state: 'expired', mine: true };
  const warning = { state: 'expired', reason: 'lease_expired', claim_id: claim.claim_id, recovery: 'Call set_proxy_routing.' };
  for (const tool of MCP_TOOLS) {
    // Every result schema must reject a malformed warning, including tools
    // without a specialized data contract.
    const result = successToolResult(tool.name, {}, { routing_warning: { ...warning, state: 'bad' } }).structuredContent;
    assert.equal(tool.outputSchema.safeParse(result).success, false, tool.name);
  }
  const validate = (name, data) => MCP_TOOLS.find(t => t.name === name).outputSchema.safeParse(successToolResult(name, {}, data).structuredContent).success;
  assert.equal(validate('get_proxy_status', { routing_claims: [claim], routing_union: ['a.test'], routing_lost_reason: 'lease_expired', routing_lost_at: claim.expires_at, routing_warning: warning }), true);
  assert.equal(validate('get_proxy_status', { routing_claims: [{ ...claim, mine: 'yes' }] }), false);
  assert.equal(validate('get_proxy_status', { routing_lost_reason: 'unknown' }), false);
  assert.equal(validate('set_proxy_routing', { status: 'routing_on', claim, routing_union: ['a.test'] }), true);
  assert.equal(validate('clear_proxy_routing', { status: 'routing_off', claim: null, routing_union: [], removed_other_claims: [claim] }), true);
  assert.equal(validate('set_proxy_routing', { routing_union: [42] }), false);
  assert.equal(validate('enable_ssl_proxying', { routing: { claim, routing_union: ['a.test'] } }), true);
  assert.equal(validate('start_proxy', { routing: { routing_union: [42] } }), false);
  assert.equal(MCP_TOOLS.find(t => t.name === 'clear_proxy_routing').inputSchema.scope.safeParse('all').success, true);
});
