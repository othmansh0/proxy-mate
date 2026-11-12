import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-efficiency-'));
process.env.PROXY_MCP_HOME = directory;
const { inspectJson } = await import('../src/lib/json-inspection.mjs');
const { makeTools } = await import('../src/lib/tools.mjs');
const { successToolResult, registerMcpTools, MCP_TOOLS } = await import('../src/lib/mcp-contract.mjs');
test.after(() => fs.rm(directory, { recursive: true, force: true }));

test('JSON queries return bounded scalar counts, escaped pointers and summaries without executing source text', () => {
  const document = { data: { items: Array.from({ length: 300 }, (_, index) => ({ vendor: index % 2 ? 'ONE' : 'AMD', count: index })) },
    'a/b': { '~key': 'process.exit(99)' } };
  const result = inspectJson(document, { pointers: ['/data/items/*/vendor', '/a~1b/~0key', '/data/items'] });
  assert.equal(result.results[0].matched_count, 300);
  assert.deepEqual(result.results[0].values.map((entry) => [entry.value, entry.count]), [['AMD', 150], ['ONE', 150]]);
  assert.equal(result.results[1].values[0].value, 'process.exit(99)');
  assert.deepEqual(result.results[2].values[0].value, { type: 'array', length: 300 });
  const limited = inspectJson(document, { pointers: ['/data/items/*/count'], max_results: 3 });
  assert.equal(limited.results[0].values.length, 3);
  assert.equal(limited.results[0].truncated, true);
  assert.throws(() => inspectJson(document, { pointers: ['$..vendor'] }), { code: 'INVALID_JSON_POINTER' });
  assert.throws(() => inspectJson(document, { pointers: ['/bad~escape'] }), { code: 'INVALID_JSON_POINTER' });
  const huge = inspectJson({ rows: Array.from({ length: 150000 }, () => 'x'.repeat(2000)) }, { pointers: ['/rows/*'], distinct: false });
  assert.ok(huge.scanned_nodes <= huge.scan_limit);
  assert.ok(Buffer.byteLength(JSON.stringify(huge)) < 14000);
  assert.equal(huge.results[0].match_count_complete, false);
});

test('spilled JSON queries remain redacted and previews redact complete JSON before truncating', async () => {
  const body = JSON.stringify({ password: 'fixture-password', data: { rows: Array.from({ length: 200 }, () => ({ vendor: 'AMD' })) }, padding: 'x'.repeat(8000) });
  const file = path.join(directory, 'body.json');
  await fs.writeFile(file, body);
  const flow = { id: 'json-flow', timestamp: Date.now(), request: { method: 'GET', url: 'https://example.test/json', headers: {} },
    response: { statusCode: 200, headers: { 'content-type': 'application/json' }, body_path: file, body_size: Buffer.byteLength(body), body_encoding: 'utf8' } };
  const tools = makeTools({ engine: { getDurableFlow: async () => flow }, pacServer: {} });
  const result = await tools.query_flow_json({ flow_id: flow.id, pointers: ['/password', '/data/rows/*/vendor'] });
  assert.equal(result.results[0].values[0].value, '[REDACTED]');
  assert.equal(result.results[1].values[0].count, 200);
  flow.response.body_inline = body;
  delete flow.response.body_path;
  const preview = await tools.get_flow_detail({ flow_id: flow.id });
  assert.equal(preview.response.body_truncated, true);
  assert.ok(Buffer.byteLength(preview.response.body_inline) < 2100);
  assert.doesNotMatch(preview.response.body_inline, /fixture-password/);
  assert.equal(JSON.parse((await tools.get_flow_detail({ flow_id: flow.id, body_mode: 'full' })).response.body_inline).password, '[REDACTED]');
});

test('compact discovery preserves matching/error evidence and compact envelopes omit duplicated aliases', async () => {
  const flows = Array.from({ length: 50 }, (_, index) => ({ id: `flow-${index}`, timestamp: index,
    request: { method: 'GET', url: `https://example.test/api/orders?page=${index}`, matched_rule_id: index === 0 ? 'task-rule' : null },
    response: { statusCode: index ? 200 : 502, body_size: 100, ...(index ? {} : { upstream_error: { source: 'proxy', code: 'ETIMEDOUT', message: 'fixture' } }) } }));
  const tools = makeTools({ engine: { flows: new Map(flows.map((flow) => [flow.id, flow])), flowOrder: flows.map((flow) => flow.id) }, pacServer: {} });
  assert.equal((await tools.get_flows()).flows.length, 10);
  const full = await tools.get_flows({ limit: 50, view: 'full' });
  const compact = await tools.get_flows({ limit: 50 });
  const evidence = compact.flows.find((flow) => flow.id === 'flow-0');
  assert.equal(evidence.matched_rule_id, 'task-rule');
  assert.equal(evidence.upstream_error.code, 'ETIMEDOUT');
  const legacy = successToolResult('get_flows', {}, full);
  const result = successToolResult('get_flows', {}, compact, undefined, { legacyAliases: false });
  assert.equal(result.structuredContent.flows, undefined);
  assert.equal(result.structuredContent.data.flows.length, 50);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < Buffer.byteLength(JSON.stringify(legacy)) * 0.7);
  assert.equal(MCP_TOOLS.find((tool) => tool.name === 'get_flows').outputSchema.safeParse(result.structuredContent).success, true);
});

test('repeated-read feedback never serves cached traffic and promotes next actions into the envelope', async () => {
  const handlers = new Map();
  let reads = 0;
  registerMcpTools({ registerTool: (name, _options, handler) => handlers.set(name, handler), sendLoggingMessage: async () => {} },
    async () => { reads += 1; return { flows: [], total: 0 }; }, { legacyAliases: false });
  let result;
  for (let index = 0; index < 3; index++) result = await handlers.get('get_flows')({}, {});
  assert.equal(reads, 3);
  assert.match(result.structuredContent.next_actions[0], /wait_for_flow/);
  assert.equal(result.structuredContent.flows, undefined);
});
