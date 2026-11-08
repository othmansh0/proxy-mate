import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('stdio MCP initializes, lists the parity surface, and returns structured content', async (t) => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, pkg.version, 'package-lock.json root version must match package.json');
  assert.equal(lock.packages?.[''].version, pkg.version, 'package-lock.json "" package entry must match package.json');
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-mcp-stdio-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'src/server.mjs'), '--in-process'],
    cwd: root,
    env: { ...process.env, PROXY_MCP_HOME: state },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'proxy-mcp-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close());

  const listed = await client.listTools();
  const names = new Set(listed.tools.map((tool) => tool.name));
  for (const expected of [
    'get_version', 'get_proxy_status', 'get_flows', 'get_flow_detail',
    'create_map_local', 'create_map_remote', 'create_blacklist',
    'filter_flows', 'export_flow_curl', 'setup_simulator_certificate',
  ]) assert.equal(names.has(expected), true, `missing MCP tool ${expected}`);
  for (const tool of listed.tools) {
    assert.equal(tool.outputSchema?.type, 'object', `${tool.name} is missing an output schema`);
    assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', `${tool.name} is missing readOnlyHint`);
    assert.equal(typeof tool.annotations?.destructiveHint, 'boolean', `${tool.name} is missing destructiveHint`);
    assert.equal(typeof tool.annotations?.idempotentHint, 'boolean', `${tool.name} is missing idempotentHint`);
    assert.equal(typeof tool.annotations?.openWorldHint, 'boolean', `${tool.name} is missing openWorldHint`);
  }

  const result = await client.callTool({ name: 'get_version', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.version, pkg.version);
  assert.equal(result.structuredContent.schema_version, '1.0');
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.data.version, pkg.version);
  assert.equal(result.structuredContent.error, null);
  assert.match(result.content[0].text, /^proxy-mcp v/);
  assert.equal(result.content[0].text.includes('{'), false);

  const resources = await client.listResources();
  assert.equal(resources.resources.some((resource) => resource.uri === 'proxy-mcp://status'), true);
  const templates = await client.listResourceTemplates();
  assert.equal(templates.resourceTemplates.some((template) => template.uriTemplate === 'proxy-mcp://flows/{flow_id}'), true);
  assert.equal(templates.resourceTemplates.some((template) => template.uriTemplate === 'proxy-mcp://flows/{flow_id}/bodies/{kind}'), true);
  assert.equal(templates.resourceTemplates.some((template) => template.uriTemplate === 'proxy-mcp://sessions/{session_id}/flows/{flow_id}'), true);
  const status = await client.readResource({ uri: 'proxy-mcp://status' });
  assert.equal(status.contents[0].mimeType, 'application/json');
  assert.equal(typeof JSON.parse(status.contents[0].text).running, 'boolean');

});
