import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.PROXY_MCP_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-mcp-rules-'));
const { ProxyEngine, compileSafeRegex } = await import('../src/lib/proxy.mjs');
const { saveRules, loadRules, exportRulesTo, importRulesFrom } = await import('../src/lib/rules.mjs');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function requestViaProxy(proxyPort, targetUrl, {
  method = 'GET', headers = {}, body = null, timeout = 2_000,
} = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: proxyPort, method, path: targetUrl, headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString(),
      }));
    });
    req.setTimeout(timeout, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

test('rule priority, order, enablement, rollback, hit metadata, and dry-run explanations', async (t) => {
  const engine = new ProxyEngine();
  await engine.start({ port: 0 });
  t.after(() => engine.stop());
  const url = 'http://rules-order.test/value?mode=test';
  const pattern = '^http://rules-order\\.test/value';

  await engine.registerRule({
    rule_id: 'later', type: 'map_local', url_pattern: pattern, order: 10,
    status: 210, content_type: 'text/plain', body: 'later',
  });
  await engine.registerRule({
    rule_id: 'first', type: 'map_local', url_pattern: pattern, order: 1,
    status: 211, content_type: 'text/plain', body: 'first',
  });
  assert.equal((await requestViaProxy(engine.port, url)).body, 'first');

  await engine.registerRule({
    rule_id: 'high', type: 'map_local', url_pattern: pattern, priority: 10, order: 99,
    status: 212, content_type: 'text/plain', body: 'high',
  });
  assert.equal((await requestViaProxy(engine.port, url)).body, 'high');
  await engine.setRuleEnabled('high', false);
  assert.equal((await requestViaProxy(engine.port, url)).body, 'first');

  await assert.rejects(
    engine.updateRule('high', { url_pattern: '(a+)+' }),
    /safe regular-expression subset/,
  );
  assert.equal(engine.listRuleConfigs().find((rule) => rule.rule_id === 'high').url_pattern, pattern);
  await engine.setRuleEnabled('high', true);
  assert.equal((await requestViaProxy(engine.port, url)).body, 'high');

  const rules = engine.listRuleConfigs();
  assert.deepEqual(rules.map((rule) => rule.rule_id), ['high', 'first', 'later']);
  assert.ok(rules.find((rule) => rule.rule_id === 'high').hit_count >= 2);
  assert.match(rules.find((rule) => rule.rule_id === 'high').last_hit, /^\d{4}-\d{2}-\d{2}T/);

  const explanation = engine.explainRuleMatch({
    url, method: 'GET', headers: {}, body: '',
  });
  assert.equal(explanation.dry_run, true);
  assert.equal(explanation.selected_rule_id, 'high');
  assert.equal(explanation.evaluations[0].matched, true);

  await engine.reorderRules(['later', 'first', 'high']);
  // Priority remains stronger than manual order.
  assert.equal((await requestViaProxy(engine.port, url)).body, 'high');
  await engine.setRulePriority('high', 0);
  assert.equal((await requestViaProxy(engine.port, url)).body, 'later');
});

test('safe regex validation rejects nested-quantifier bypasses and unsupported backtracking features', () => {
  for (const pattern of [
    '(a+)+$', '(a{1,3})+$', '(?:a*)+$', '((a+))+$', '(a|aa)+$', '(?:foo|bar)+$', '(a+)\\1', '(?=a)a', '.*middle.*end',
  ]) {
    assert.throws(() => compileSafeRegex(pattern, 'test_pattern'), (error) => error.code === 'UNSAFE_REGULAR_EXPRESSION', pattern);
  }
  assert.equal(compileSafeRegex('^https?://[^/]+/items(?:/[^?]+)?$').test('https://example.test/items/1'), true);
});

test('Map Remote transforms method, headers, body, status and response while optionally preserving Host', async (t) => {
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(201, { 'content-type': 'application/json', 'x-upstream': 'yes' });
      res.end(JSON.stringify({
        method: req.method,
        url: req.url,
        host: req.headers.host,
        added: req.headers['x-added'],
        body: Buffer.concat(chunks).toString(),
      }));
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const engine = new ProxyEngine();
  await engine.start({ port: 0 });
  t.after(() => engine.stop());
  await engine.registerRule({
    rule_id: 'transform', type: 'map_remote',
    url_pattern: '^http://transform-rule\\.test/',
    to_url: `http://127.0.0.1:${upstreamPort}`,
    preserve_host_header: true,
    request_transform: {
      replace_method: 'PATCH',
      update_headers: { 'x-added': 'yes' },
      replace_body: 'transformed-request',
    },
    response_transform: {
      replace_status: 299,
      update_headers: { 'x-transformed': 'yes' },
      replace_body: 'transformed-response',
    },
  });
  const response = await requestViaProxy(engine.port, 'http://transform-rule.test/original', {
    method: 'POST', headers: { host: 'transform-rule.test', 'content-type': 'text/plain' }, body: 'original',
  });
  assert.equal(response.status, 299);
  assert.equal(response.headers['x-transformed'], 'yes');
  assert.equal(response.body, 'transformed-response');

  await engine.updateRule('transform', { response_transform: null });
  const inspected = await requestViaProxy(engine.port, 'http://transform-rule.test/original', {
    method: 'POST', headers: { host: 'transform-rule.test', 'content-type': 'text/plain' }, body: 'original',
  });
  const upstreamView = JSON.parse(inspected.body);
  assert.equal(upstreamView.method, 'PATCH');
  assert.equal(upstreamView.host, 'transform-rule.test');
  assert.equal(upstreamView.added, 'yes');
  assert.equal(upstreamView.body, 'transformed-request');

  await engine.updateRule('transform', {
    to_url: `http://127.0.0.1:${upstreamPort}/mapped`,
    preserve_host_header: false,
    replace_query: 'mapped=true',
  });
  const remapped = JSON.parse((await requestViaProxy(
    engine.port,
    'http://transform-rule.test/original?old=true',
    { method: 'POST', headers: { host: 'transform-rule.test', 'content-type': 'text/plain' }, body: 'original' },
  )).body);
  assert.equal(remapped.url, '/mapped?mapped=true');
  assert.equal(remapped.host, `127.0.0.1:${upstreamPort}`);
});

test('fault rules can close a matching connection after a deterministic delay', async (t) => {
  const engine = new ProxyEngine();
  await engine.start({ port: 0 });
  t.after(() => engine.stop());
  await engine.registerRule({
    rule_id: 'delayed-close', type: 'blacklist',
    url_pattern: '^http://fault-rule\\.test/',
    fault: 'close', delay_ms: 30,
  });
  const started = Date.now();
  await assert.rejects(requestViaProxy(engine.port, 'http://fault-rule.test/value'));
  assert.ok(Date.now() - started >= 20);
  const config = engine.listRuleConfigs()[0];
  assert.equal(config.fault, 'close');
  assert.equal(config.hit_count, 1);
});

test('Map Local directory serves safe files, falls through misses, and supports delay', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-mcp-map-directory-'));
  await fs.writeFile(path.join(root, 'fixture.txt'), 'directory fixture');
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`upstream:${req.url}`);
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const engine = new ProxyEngine();
  await engine.start({ port: 0 });
  t.after(() => engine.stop());
  const origin = `http://127.0.0.1:${upstreamPort}`;
  await engine.registerRule({
    rule_id: 'directory', type: 'map_local',
    url_pattern: `^${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`,
    directory: root, fallthrough: true, delay_ms: 35, status: 203,
  });

  const started = Date.now();
  const local = await requestViaProxy(engine.port, `${origin}/fixture.txt`);
  assert.equal(local.status, 203);
  assert.equal(local.body, 'directory fixture');
  assert.equal(local.headers['content-type'], 'text/plain; charset=utf-8');
  assert.ok(Date.now() - started >= 25);

  const missed = await requestViaProxy(engine.port, `${origin}/missing.txt`);
  assert.equal(missed.status, 200);
  assert.equal(missed.body, 'upstream:/missing.txt');
  const traversal = await requestViaProxy(engine.port, `${origin}/%2e%2e/outside.txt`);
  assert.equal(traversal.status, 200);
});

test('rule persistence version 2 keeps lifecycle metadata and portable directories', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-mcp-rules-assets-'));
  await fs.writeFile(path.join(directory, 'one.json'), '{"one":true}');
  const rules = [{
    rule_id: 'portable-dir', type: 'map_local', url_pattern: 'example', method: 'ANY',
    directory, enabled: false, priority: 3, order: 2, hit_count: 4,
  }];
  await saveRules(rules);
  assert.deepEqual(await loadRules(), rules);
  const exportPath = path.join(process.env.PROXY_MCP_HOME, 'rules-portable.json');
  await exportRulesTo(rules, exportPath);
  const imported = await importRulesFrom(exportPath);
  assert.equal(imported[0].enabled, false);
  assert.equal(imported[0].hit_count, 4);
  assert.equal(await fs.readFile(path.join(imported[0].directory, 'one.json'), 'utf8'), '{"one":true}');
});
