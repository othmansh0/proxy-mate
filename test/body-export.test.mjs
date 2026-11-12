import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-safe-export-'));
process.env.PROXY_MCP_HOME = directory;
const { bodyForExport } = await import('../src/lib/body-export.mjs');
const { makeTools } = await import('../src/lib/tools.mjs');
test.after(() => fs.rm(directory, { recursive: true, force: true }));

async function fixture() {
  const file = path.join(directory, `${crypto.randomUUID()}.json`);
  const text = JSON.stringify({ data: 'x'.repeat(80_000), password: 'fixture-secret' });
  await fs.writeFile(file, text);
  const part = { headers: { 'content-type': 'application/json' }, body_path: file, body_size: Buffer.byteLength(text), body_encoding: 'utf8' };
  const flow = { id: crypto.randomUUID(), timestamp: Date.now(), request: { method: 'POST', url: 'https://example.test/api', ...part },
    response: { statusCode: 200, ...part, headers: { ...part.headers, location: '/next?token=redirect-fixture-secret' } } };
  const engine = { flows: new Map([[flow.id, flow]]), flowOrder: [flow.id], getDurableFlow: async () => flow,
    sessionId: 'test', sessionStore: {
      exportSession: async () => ({ session: { flows: [structuredClone(flow)] } }),
      getFlow: async () => flow,
    } };
  return { part, flow, tools: makeTools({ engine, pacServer: {} }) };
}

test('redacted spilled JSON exports to private files, HAR and portable sessions without a sensitive grant', async () => {
  const { flow, tools } = await fixture();
  const saved = await tools.save_body_to_file({ flow_id: flow.id });
  const body = await fs.readFile(saved.path, 'utf8');
  assert.equal(JSON.parse(body).data.length, 80_000);
  assert.equal(JSON.parse(body).password, '[REDACTED]');
  assert.equal(saved.redacted, true);
  assert.equal(saved.size, Buffer.byteLength(body));
  assert.equal(saved.sha, crypto.createHash('sha256').update(body).digest('hex'));
  assert.equal((await fs.stat(saved.path)).mode & 0o777, 0o600);
  const harResult = await tools.export_har({});
  const har = JSON.parse(await fs.readFile(harResult.path, 'utf8'));
  const entry = har.log.entries[0];
  for (const text of [entry.request.postData.text, entry.response.content.text]) {
    assert.equal(JSON.parse(text).data.length, 80_000);
    assert.equal(JSON.parse(text).password, '[REDACTED]');
  }
  assert.doesNotMatch(entry.response.redirectURL, /redirect-fixture-secret/);
  assert.equal(harResult.omitted_body_count, 0);
  const archive = await tools.export_capture_session({});
  const doc = JSON.parse(await fs.readFile(archive.path, 'utf8'));
  assert.equal(JSON.parse(doc.session.flows[0].response.body_inline).password, '[REDACTED]');
  assert.equal(archive.omitted_body_count, 0);
  await assert.rejects(tools.save_body_to_file({ flow_id: flow.id, include_sensitive: true }), { code: 'SENSITIVE_ACCESS_DISABLED' });
  await assert.rejects(tools.save_body_to_file({ flow_id: flow.id, path: path.join(os.tmpdir(), 'outside-proxy-export.txt') }), { code: 'PATH_NOT_AUTHORIZED' });
});

test('exports explain binary, unavailable and bounded body omissions', async () => {
  const { part, tools } = await fixture();
  assert.match((await bodyForExport(part, { maxBytes: 1024 })).reason, /byte limit/);
  assert.match((await bodyForExport({ body_base64: Buffer.from([0, 255, 1]).toString('base64'), body_encoding: 'binary' })).reason, /binary/);
  assert.match((await bodyForExport({ body_path: path.join(directory, 'missing.txt'), body_size: 10 })).reason, /no longer available/);
  const binary = await bodyForExport({ body_base64: 'AP8B', body_encoding: 'binary' }, { includeSensitive: true });
  assert.deepEqual(binary.buffer, Buffer.from([0, 255, 1]));
  const unavailable = await bodyForExport({ body_size: 5, body_omitted: 'metadata only' });
  assert.equal(unavailable.omitted, true);
  assert.equal(unavailable.reason, 'metadata only');
  assert.ok(tools);
});
