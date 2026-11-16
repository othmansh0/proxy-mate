import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

process.env.PROXY_MATE_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-mate-rules-'));
const { ProxyEngine, compileSafeRegex } = await import('../src/lib/proxy.mjs');
const { saveRules, loadRules, exportRulesTo, importRulesFrom } = await import('../src/lib/rules.mjs');
const { makeTools } = await import('../src/lib/tools.mjs');
const { registerMcpTools } = await import('../src/lib/mcp-contract.mjs');

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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-mate-map-directory-'));
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

test('rules built from a query-bearing URL match that query instead of an unmatchable regex', async (t) => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`upstream:${req.url}`);
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const engine = new ProxyEngine();
  await engine.start({ port: 0 });
  t.after(() => engine.stop());
  const tools = makeTools({ engine, pacServer: {}, mode: 'test' });
  const origin = `http://127.0.0.1:${upstreamPort}`;
  const escapedOrigin = origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Mockttp cuts the query before testing url_pattern, so the query has to
  // travel as match_query or the rule can never fire.
  const withQuery = await tools.create_map_local({
    rule_id: 'query-rule', url: `${origin}/v1/users?active=1&role=admin`,
    status: 201, content_type: 'text/plain', body: 'mocked-users',
  });
  assert.equal(withQuery.url_pattern, `^${escapedOrigin}/v1/users$`);
  assert.deepEqual(withQuery.match_query, { active: '1', role: 'admin' });

  const matched = await requestViaProxy(engine.port, `${origin}/v1/users?active=1&role=admin`);
  assert.equal(matched.status, 201);
  assert.equal(matched.body, 'mocked-users');

  const differentQuery = await requestViaProxy(engine.port, `${origin}/v1/users?active=0&role=admin`);
  assert.equal(differentQuery.status, 200);
  assert.equal(differentQuery.body, 'upstream:/v1/users?active=0&role=admin');
  const missingQuery = await requestViaProxy(engine.port, `${origin}/v1/users`);
  assert.equal(missingQuery.status, 200);

  // A query-less URL keeps the historical pattern and adds no query matcher.
  const withoutQuery = await tools.create_map_local({
    rule_id: 'plain-rule', url: `${origin}/v1/plain`,
    status: 202, content_type: 'text/plain', body: 'plain',
  });
  assert.equal(withoutQuery.url_pattern, `^${escapedOrigin}/v1/plain$`);
  assert.equal(withoutQuery.match_query, null);
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/plain?ignored=1`)).body, 'plain');

  // A caller-supplied match_query wins over the value derived from the URL.
  const overridden = await tools.create_blacklist({
    rule_id: 'override-rule', url: `${origin}/v1/blocked?page=1`,
    match_query: { page: '9' }, status: 451, body_inline: 'blocked',
  });
  assert.deepEqual(overridden.match_query, { page: '9' });
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/blocked?page=9`)).status, 451);
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/blocked?page=1`)).status, 200);

  // The first '?' is always the query separator: '?' is not a glob in `url`,
  // and the fragment is cut before the query is looked for. Callers who want a
  // regex pass url_pattern, which short-circuits all of this.
  const cases = [
    ['http://api.example.com/v1/users?active=1', '^http://api\\.example\\.com/v1/users$', { active: '1' }],
    ['*/v1/users?active=1', '^.*/v1/users$', { active: '1' }],
    ['http://x/a?b=1&c=2', '^http://x/a$', { b: '1', c: '2' }],
    ['http://x/a?b=1&b=2', '^http://x/a$', { b: ['1', '2'] }],
    // A flag parameter carries an empty value, exactly as url.parse reports it.
    ['http://x/a?debug', '^http://x/a$', { debug: '' }],
    // Former globs: the '?' now separates, so the tail becomes a query key.
    ['http://host/v?/users', '^http://host/v$', { '/users': '' }],
    ['https://api.test/????/x', '^https://api\\.test/$', { '???/x': '' }],
    // A trailing bare '?' is no query constraint, not an unmatchable rule.
    ['http://host/v2/items?', '^http://host/v2/items$', null],
    // Everything after '#' is fragment, so that '?' never separates.
    ['http://x/a#frag?b=1', '^http://x/a$', null],
    ['http://x/a?b=1#frag', '^http://x/a$', { b: '1' }],
  ];
  for (const [index, [url, pattern, query]] of cases.entries()) {
    const rule = await tools.create_map_local({
      rule_id: `split-case-${index}`, url,
      status: 203, content_type: 'text/plain', body: 'case',
    });
    assert.equal(rule.url_pattern, pattern, url);
    if (query) assert.deepEqual(rule.match_query, query, url);
    else assert.equal(rule.match_query, null, url);
    await tools.remove_rule({ rule_id: rule.rule_id });
  }

  // A caller-supplied url_pattern short-circuits the split, so '?' keeps every
  // regex meaning there.
  const patternRule = await tools.create_map_local({
    rule_id: 'pattern-live', url_pattern: `^${escapedOrigin}/v./users$`,
    status: 213, content_type: 'text/plain', body: 'pattern-hit',
  });
  assert.equal(patternRule.match_query, null);
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/users?ignored=1`)).body, 'pattern-hit');
  assert.equal((await requestViaProxy(engine.port, `${origin}/v12/users`)).body, 'upstream:/v12/users');
  await tools.remove_rule({ rule_id: 'pattern-live' });

  // Live traffic: a flag parameter matches only when the flag is present.
  await tools.create_map_local({
    rule_id: 'flag-live', url: `${origin}/v1/flag?debug`,
    status: 214, content_type: 'text/plain', body: 'flag-hit',
  });
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/flag?debug`)).body, 'flag-hit');
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/flag`)).body, 'upstream:/v1/flag');
  await tools.remove_rule({ rule_id: 'flag-live' });

  // Live traffic: a trailing bare '?' constrains nothing, and a fragment is cut.
  await tools.create_map_local({
    rule_id: 'bare-live', url: `${origin}/v1/items?`,
    status: 215, content_type: 'text/plain', body: 'bare-hit',
  });
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/items`)).body, 'bare-hit');
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/items?any=1`)).body, 'bare-hit');
  await tools.remove_rule({ rule_id: 'bare-live' });

  await tools.create_map_local({
    rule_id: 'fragment-live', url: `${origin}/v1/frag#section?a=1`,
    status: 216, content_type: 'text/plain', body: 'fragment-hit',
  });
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/frag`)).body, 'fragment-hit');
  await tools.remove_rule({ rule_id: 'fragment-live' });

  // Live traffic: the wildcard form the schema advertises splits its query off.
  const wildcardRule = await tools.create_map_local({
    rule_id: 'wildcard-live', url: '*/v1/users?active=1',
    status: 206, content_type: 'text/plain', body: 'wildcard-hit',
  });
  assert.deepEqual(wildcardRule.match_query, { active: '1' });
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/users?active=1`)).body, 'wildcard-hit');
  assert.equal(
    (await requestViaProxy(engine.port, `${origin}/v1/users?active=0`)).body,
    'upstream:/v1/users?active=0',
  );
  await tools.remove_rule({ rule_id: 'wildcard-live' });

  // Live traffic: a blacklist built from a query-bearing absolute URL blocks.
  await tools.create_blacklist({
    rule_id: 'blocked-live', url: `${origin}/v1/secret?token=abc`,
    status: 403, body_inline: 'denied',
  });
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/secret?token=abc`)).status, 403);
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/secret?token=xyz`)).status, 200);
  await tools.remove_rule({ rule_id: 'blocked-live' });

  // Live traffic: a '__proto__' query key has to stay an own property. Built on
  // a '{}' literal it writes the prototype slot instead, leaving match_query
  // {}, and withQuery({}) matches every request — so this blacklist would block
  // the whole path rather than the one query it names.
  const protoRule = await tools.create_blacklist({
    rule_id: 'proto-live', url: `${origin}/v1/proto?__proto__=evil&constructor=c&prototype=p`,
    status: 403, body_inline: 'denied',
  });
  assert.deepEqual(Object.keys(protoRule.match_query), ['__proto__', 'constructor', 'prototype']);
  assert.equal(JSON.stringify(protoRule.match_query), '{"__proto__":"evil","constructor":"c","prototype":"p"}');
  const pollutedQuery = '__proto__=evil&constructor=c&prototype=p';
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/proto?${pollutedQuery}`)).status, 403);
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/proto?other=1`)).status, 200);
  assert.equal({}.evil, undefined);
  await tools.remove_rule({ rule_id: 'proto-live' });

  // '__proto__' alone is the worst case: lose it and match_query is {}, which
  // blocks every request to the path instead of the one query.
  const onlyProto = await tools.create_blacklist({
    rule_id: 'only-proto-live', url: `${origin}/v1/only-proto?__proto__=evil`,
    status: 403, body_inline: 'denied',
  });
  assert.deepEqual(Object.keys(onlyProto.match_query), ['__proto__']);
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/only-proto?__proto__=evil`)).status, 403);
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/only-proto?other=1`)).status, 200);
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/only-proto`)).status, 200);
});

test('dry-run URL matching mirrors mockttp on default ports and method-specific path matchers', async (t) => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`upstream:${req.url}`);
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const engine = new ProxyEngine();
  await engine.start({ port: 0 });
  t.after(() => engine.stop());
  const tools = makeTools({ engine, pacServer: {}, mode: 'test' });
  const origin = `http://127.0.0.1:${upstreamPort}`;

  // Mockttp normalizes a default port away before matching, so a pattern that
  // keeps ':80' can never fire. The dry run has to report that, not a match.
  // '.invalid' never resolves, so a live 502 proves the rule did not fire.
  const wireUrl = 'http://port-parity.invalid:80/v1/x';
  const withPort = await tools.create_map_local({
    rule_id: 'default-port', url: wireUrl,
    status: 217, content_type: 'text/plain', body: 'port-hit',
  });
  assert.equal(withPort.url_pattern, '^http://port-parity\\.invalid:80/v1/x$');
  assert.equal(engine.testRuleMatch('default-port', { url: wireUrl, method: 'GET' }).matched, false);
  assert.equal((await requestViaProxy(engine.port, wireUrl)).status, 502);
  await tools.remove_rule({ rule_id: 'default-port' });

  // The same wire request against the port-less pattern matches both ways.
  await tools.create_map_local({
    rule_id: 'no-port', url: 'http://port-parity.invalid/v1/x',
    status: 217, content_type: 'text/plain', body: 'port-hit',
  });
  assert.equal(engine.testRuleMatch('no-port', { url: wireUrl, method: 'GET' }).matched, true);
  assert.equal((await requestViaProxy(engine.port, wireUrl)).body, 'port-hit');
  await tools.remove_rule({ rule_id: 'no-port' });

  // A method-specific rule compiles to a RegexPathMatcher, which tests the
  // pattern against the path alone as well as the full URL, so a path-only
  // pattern blocks live and the dry run must agree.
  await tools.create_blacklist({
    rule_id: 'path-get', url_pattern: '^/v1/secret$', method: 'GET',
    status: 403, body_inline: 'denied',
  });
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/secret`)).status, 403);
  assert.equal(engine.testRuleMatch('path-get', { url: `${origin}/v1/secret`, method: 'GET' }).matched, true);
  // The method still has to match, path matcher or not.
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/secret`, { method: 'POST' })).status, 200);
  assert.equal(engine.testRuleMatch('path-get', { url: `${origin}/v1/secret`, method: 'POST' }).matched, false);
  await tools.remove_rule({ rule_id: 'path-get' });

  // Method 'ANY' goes through withUrlMatching instead, which tests the full URL
  // only, so the same path-only pattern misses live and in the dry run.
  await tools.create_blacklist({
    rule_id: 'path-any', url_pattern: '^/v1/secret$', method: 'ANY',
    status: 403, body_inline: 'denied',
  });
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/secret`)).status, 200);
  assert.equal(engine.testRuleMatch('path-any', { url: `${origin}/v1/secret`, method: 'GET' }).matched, false);
});

test('rule persistence version 2 keeps lifecycle metadata and portable directories', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-mate-rules-assets-'));
  await fs.writeFile(path.join(directory, 'one.json'), '{"one":true}');
  const rules = [{
    rule_id: 'portable-dir', type: 'map_local', url_pattern: 'example', method: 'ANY',
    directory, enabled: false, priority: 3, order: 2, hit_count: 4,
  }];
  await saveRules(rules);
  assert.deepEqual(await loadRules(), rules);
  const exportPath = path.join(process.env.PROXY_MATE_HOME, 'rules-portable.json');
  await exportRulesTo(rules, exportPath);
  const imported = await importRulesFrom(exportPath);
  assert.equal(imported[0].enabled, false);
  assert.equal(imported[0].hit_count, 4);
  assert.equal(await fs.readFile(path.join(imported[0].directory, 'one.json'), 'utf8'), '{"one":true}');
});

test('an empty, malformed, or unbounded match_query is refused instead of matching everything', async (t) => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`upstream:${req.url}`);
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const engine = new ProxyEngine();
  await engine.start({ port: 0 });
  t.after(() => engine.stop());
  const tools = makeTools({ engine, pacServer: {}, mode: 'test' });
  const origin = `http://127.0.0.1:${upstreamPort}`;

  // How an empty match_query reaches the engine: a '__proto__' key assigned
  // onto a '{}' literal writes the prototype slot instead of an own property,
  // so a one-parameter constraint collapses to {}. (The MCP schema no longer
  // drops it — see the '__proto__ survives the MCP schema' test — but a
  // hand-written rules.json or a caller building the object that way still can.)
  const collapsed = {};
  collapsed['__proto__'] = 'evil';
  assert.deepEqual(Object.keys(collapsed), []);

  // mockttp runs _.isMatch(query, {}), which is unconditionally true, so this
  // blacklist would have blocked every request to /v1/only rather than one.
  await assert.rejects(
    tools.create_blacklist({
      rule_id: 'empty-query', url: `${origin}/v1/only`, match_query: {}, status: 403, body_inline: 'denied',
    }),
    (error) => {
      assert.equal(error.code, 'MATCH_QUERY_EMPTY');
      assert.equal(error.retryable, false);
      assert.ok(error.recovery.length > 0);
      return true;
    },
  );
  assert.deepEqual(engine.listRuleConfigs(), []);
  // Live: nothing was registered, so the whole path still reaches upstream.
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/only`)).body, 'upstream:/v1/only');
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/only?a=1`)).body, 'upstream:/v1/only?a=1');

  await assert.rejects(
    tools.create_map_local({ rule_id: 'bad-query', url: `${origin}/v1/bad`, match_query: 'a=1' }),
    (error) => error.code === 'MATCH_QUERY_INVALID',
  );

  // Bound (a): past mockttp's parser cap the rule is permanently dead, because
  // url.parse(url, true) stops at 1000 pairs and never sees key 1001.
  const overCap = Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [`k${index}`, 'v']));
  await assert.rejects(
    tools.create_map_local({ rule_id: 'huge-query', url: `${origin}/v1/many`, match_query: overCap }),
    (error) => error.code === 'QUERY_TOO_LARGE' && error.retryable === false,
  );

  // Bound (b): moving the query out of url_pattern removed its 500-character
  // bound, so a megabyte-scale query registered and was persisted verbatim.
  await assert.rejects(
    tools.create_blacklist({ rule_id: 'fat-query', url: `${origin}/v1/fat?k=${'v'.repeat(200_000)}` }),
    (error) => error.code === 'QUERY_TOO_LARGE',
  );
  assert.deepEqual(engine.listRuleConfigs(), []);

  // Every registration path is covered, not just the create tools.
  await tools.create_map_local({
    rule_id: 'patchable', url: `${origin}/v1/patch?a=1`, status: 201, content_type: 'text/plain', body: 'patched',
  });
  await assert.rejects(
    tools.update_rule({ rule_id: 'patchable', patch: { match_query: {} } }),
    (error) => error.code === 'MATCH_QUERY_EMPTY',
  );
  await assert.rejects(
    engine.registerRule({ rule_id: 'imported', url_pattern: '^http://x/$', match_query: {} }),
    (error) => error.code === 'MATCH_QUERY_EMPTY',
  );
  // The rejected patch left the rule exactly as it was.
  assert.deepEqual(engine.listRuleConfigs()[0].match_query, { a: '1' });
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/patch?a=1`)).body, 'patched');
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/patch?a=2`)).body, 'upstream:/v1/patch?a=2');
});

test("a '__proto__' match_query survives the real MCP schema and constrains the live rule", async (t) => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`upstream:${req.url}`);
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const engine = new ProxyEngine();
  await engine.start({ port: 0 });
  t.after(() => engine.stop());
  const tools = makeTools({ engine, pacServer: {}, mode: 'test' });
  const origin = `http://127.0.0.1:${upstreamPort}`;

  // The real registry, the real schemas, the real SDK parse — a unit test on
  // the schema object alone would not prove the key reaches the handler.
  const server = new McpServer({ name: 'proxy-mate-test', version: '0.0.0' });
  registerMcpTools(server, async (name, args) => tools[name](args));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'proxy-mate-test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(() => client.close());

  // The advertised contract is unchanged: match_query is still an object of
  // strings or string arrays. Keeping the key cost nothing at the surface.
  const listed = await client.listTools();
  const advertised = listed.tools.find((tool) => tool.name === 'create_blacklist').inputSchema;
  assert.deepEqual(advertised.properties.match_query, {
    type: 'object',
    propertyNames: { type: 'string' },
    additionalProperties: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
  });
  assert.deepEqual(advertised.required, ['url']);

  // MCP is JSON-RPC, and JSON.parse makes '__proto__' an own enumerable key —
  // only an object literal writes the prototype slot instead. So the key really
  // does arrive, and zod's z.record used to be what discarded it.
  const args = JSON.parse(`{
    "rule_id": "proto-schema", "url": "${origin}/v1/guard",
    "match_query": {"__proto__": "evil", "b": "1"},
    "status": 403, "body_inline": "denied"
  }`);
  assert.deepEqual(Object.keys(args.match_query), ['__proto__', 'b']);

  const result = await client.callTool({ name: 'create_blacklist', arguments: args });
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent?.error));
  // The rule is reported back with the constraint it was given: a result
  // rebuilt by assignment would send '__proto__' to the prototype slot and read
  // back as the broader rule the caller did not ask for.
  assert.deepEqual(Object.keys(result.structuredContent.data.match_query), ['__proto__', 'b']);

  // Dropping '__proto__' would have left the narrower constraint {b:'1'}, and a
  // rule that loses a constraint blocks MORE than the caller asked for.
  const registered = engine.listRuleConfigs().find((rule) => rule.rule_id === 'proto-schema');
  assert.deepEqual(Object.keys(registered.match_query), ['__proto__', 'b']);
  assert.equal(registered.match_query['__proto__'], 'evil');

  // Live: only the query the caller named is blocked.
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/guard?__proto__=evil&b=1`)).status, 403);
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/guard?b=1`)).body, 'upstream:/v1/guard?b=1');
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/guard?__proto__=other&b=1`)).body, 'upstream:/v1/guard?__proto__=other&b=1');
  assert.equal(engine.testRuleMatch('proto-schema', { url: `${origin}/v1/guard?__proto__=evil&b=1`, method: 'GET' }).matched, true);
  assert.equal(engine.testRuleMatch('proto-schema', { url: `${origin}/v1/guard?b=1`, method: 'GET' }).matched, false);
  assert.equal({}.evil, undefined);

  // The schema still rejects the shapes the record it replaced rejected.
  for (const bad of ['a=1', ['a'], 42, { a: 1 }, { a: [1] }]) {
    const rejected = await client.callTool({
      name: 'create_blacklist',
      arguments: { rule_id: 'proto-bad', url: `${origin}/v1/bad`, match_query: bad },
    });
    assert.equal(rejected.isError, true, JSON.stringify(bad));
  }
  assert.deepEqual(engine.listRuleConfigs().map((rule) => rule.rule_id), ['proto-schema']);
});

test('an empty or prototype-shaped match_headers is refused or kept, never widened to the whole path', async (t) => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`upstream:${req.url}`);
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const engine = new ProxyEngine();
  await engine.start({ port: 0 });
  t.after(() => engine.stop());
  const tools = makeTools({ engine, pacServer: {}, mode: 'test' });
  const origin = `http://127.0.0.1:${upstreamPort}`;

  const server = new McpServer({ name: 'proxy-mate-test', version: '0.0.0' });
  registerMcpTools(server, async (name, args) => tools[name](args));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'proxy-mate-test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(() => client.close());

  // The advertised contract is unchanged: still an object of strings, exactly
  // what the z.record it replaced advertised.
  const listed = await client.listTools();
  const advertised = listed.tools.find((tool) => tool.name === 'create_map_local').inputSchema;
  assert.deepEqual(advertised.properties.match_headers, {
    type: 'object',
    propertyNames: { type: 'string' },
    additionalProperties: { type: 'string' },
  });

  // zod's z.record dropped a '__proto__' key here exactly as it did in
  // match_query, and a match_headers that loses its only key is {} — which
  // mockttp's withHeaders answers for EVERY request on the path.
  const args = JSON.parse(`{
    "rule_id": "proto-headers", "url": "${origin}/v1/h",
    "match_headers": {"__proto__": "evil"},
    "status": 299, "content_type": "text/plain", "body": "mock-hit"
  }`);
  assert.deepEqual(Object.keys(args.match_headers), ['__proto__']);
  const result = await client.callTool({ name: 'create_map_local', arguments: args });
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent?.error));
  const registered = engine.listRuleConfigs().find((rule) => rule.rule_id === 'proto-headers');
  assert.deepEqual(Object.keys(registered.match_headers), ['__proto__']);
  assert.equal(registered.match_headers['__proto__'], 'evil');

  // Live: the constraint survived, so the path is not mocked out from under
  // every caller. Neither Node nor mockttp ever exposes '__proto__' as an own
  // header key, so this particular rule matches nothing at all — narrow to the
  // point of being dead, which is the safe direction to fail.
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/h`)).body, 'upstream:/v1/h');
  assert.equal(
    (await requestViaProxy(engine.port, `${origin}/v1/h`, { headers: JSON.parse('{"__proto__":"evil"}') })).body,
    'upstream:/v1/h',
  );
  assert.equal({}.evil, undefined);
  await tools.remove_rule({ rule_id: 'proto-headers' });

  // A header constraint the wire can carry still matches only what it names.
  await tools.create_map_local({
    rule_id: 'named-header', url: `${origin}/v1/n`, match_headers: { 'x-api-key': 'k' },
    status: 298, content_type: 'text/plain', body: 'header-hit',
  });
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/n`, { headers: { 'x-api-key': 'k' } })).body, 'header-hit');
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/n`)).body, 'upstream:/v1/n');
  await tools.remove_rule({ rule_id: 'named-header' });

  // The other half of the same hole: an empty object is not a weak constraint
  // but the absence of one, so a blacklist meant for one caller would block the
  // whole path.
  const collapsed = {};
  collapsed['__proto__'] = 'evil';
  assert.deepEqual(Object.keys(collapsed), []);
  await assert.rejects(
    tools.create_blacklist({
      rule_id: 'empty-headers', url: `${origin}/v1/only`, match_headers: collapsed, status: 403, body_inline: 'denied',
    }),
    (error) => {
      assert.equal(error.code, 'MATCH_HEADERS_EMPTY');
      assert.equal(error.retryable, false);
      assert.ok(error.recovery.length > 0);
      return true;
    },
  );
  assert.deepEqual(engine.listRuleConfigs(), []);
  // Live: nothing was registered, so the whole path still reaches upstream.
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/only`)).body, 'upstream:/v1/only');
  assert.equal(
    (await requestViaProxy(engine.port, `${origin}/v1/only`, { headers: { 'x-api-key': 'k' } })).body,
    'upstream:/v1/only',
  );

  await assert.rejects(
    tools.create_map_local({ rule_id: 'bad-headers', url: `${origin}/v1/bad`, match_headers: 'x-api-key: k' }),
    (error) => error.code === 'MATCH_HEADERS_INVALID' && error.retryable === false,
  );
  // The empty matcher one level down: _.isMatch reads an expected [] as a
  // vacuous subset of an array actual, so it matches any value a repeated
  // header arrives with.
  await assert.rejects(
    tools.create_map_local({ rule_id: 'empty-value', url: `${origin}/v1/bad`, match_headers: { 'set-cookie': [] } }),
    (error) => error.code === 'MATCH_HEADERS_EMPTY_VALUE' && error.retryable === false,
  );

  // Every registration path is covered, not just the create tools.
  await tools.create_map_local({
    rule_id: 'patchable-headers', url: `${origin}/v1/patch`, match_headers: { 'x-api-key': 'k' },
    status: 201, content_type: 'text/plain', body: 'patched',
  });
  await assert.rejects(
    tools.update_rule({ rule_id: 'patchable-headers', patch: { match_headers: {} } }),
    (error) => error.code === 'MATCH_HEADERS_EMPTY',
  );
  await assert.rejects(
    engine.registerRule({ rule_id: 'imported-headers', url_pattern: '^http://x/$', match_headers: {} }),
    (error) => error.code === 'MATCH_HEADERS_EMPTY',
  );
  // The rejected patch left the rule exactly as it was.
  assert.deepEqual(engine.listRuleConfigs()[0].match_headers, { 'x-api-key': 'k' });
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/patch`, { headers: { 'x-api-key': 'k' } })).body, 'patched');
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/patch`)).body, 'upstream:/v1/patch');
});

test('dry-run query matching agrees with the live proxy on scalar and repeated parameters', async (t) => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`upstream:${req.url}`);
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const engine = new ProxyEngine();
  await engine.start({ port: 0 });
  t.after(() => engine.stop());
  const tools = makeTools({ engine, pacServer: {}, mode: 'test' });
  const origin = `http://127.0.0.1:${upstreamPort}`;

  await tools.create_map_local({
    rule_id: 'array-query', url: `${origin}/v1/x`, match_query: { b: ['1'] },
    status: 218, content_type: 'text/plain', body: 'array-hit',
  });
  // querystring only builds an array for a repeated key, and lodash compares an
  // array expectation against a scalar by tag, so ?b=1 does NOT match. The dry
  // run used to wrap the actual in an array and claim it did.
  const single = `${origin}/v1/x?b=1`;
  assert.equal((await requestViaProxy(engine.port, single)).body, 'upstream:/v1/x?b=1');
  assert.equal(engine.testRuleMatch('array-query', { url: single, method: 'GET' }).matched, false);
  // Repeat the key and both agree the other way.
  const repeated = `${origin}/v1/x?b=1&b=2`;
  assert.equal((await requestViaProxy(engine.port, repeated)).body, 'array-hit');
  assert.equal(engine.testRuleMatch('array-query', { url: repeated, method: 'GET' }).matched, true);

  // The mirror image: a scalar expectation never matches a repeated key.
  await tools.create_map_local({
    rule_id: 'scalar-query', url: `${origin}/v1/y?b=1`,
    status: 219, content_type: 'text/plain', body: 'scalar-hit',
  });
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/y?b=1`)).body, 'scalar-hit');
  assert.equal(engine.testRuleMatch('scalar-query', { url: `${origin}/v1/y?b=1`, method: 'GET' }).matched, true);
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/y?b=1&b=2`)).body, 'upstream:/v1/y?b=1&b=2');
  assert.equal(engine.testRuleMatch('scalar-query', { url: `${origin}/v1/y?b=1&b=2`, method: 'GET' }).matched, false);

  // A '__proto__' parameter is an ordinary own key on both sides.
  await tools.create_blacklist({
    rule_id: 'proto-query', url: `${origin}/v1/z?__proto__=evil`, status: 403, body_inline: 'denied',
  });
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/z?__proto__=evil`)).status, 403);
  assert.equal(engine.testRuleMatch('proto-query', { url: `${origin}/v1/z?__proto__=evil`, method: 'GET' }).matched, true);
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/z?other=1`)).status, 200);
  assert.equal(engine.testRuleMatch('proto-query', { url: `${origin}/v1/z?other=1`, method: 'GET' }).matched, false);

  // Past the parser cap the live proxy stops seeing parameters: mockttp reads
  // the request with url.parse(url, true), whose querystring parser keeps the
  // first 1000 pairs. The dry run built its query with URLSearchParams, which
  // has no cap, so the two disagreed about every request past the cap.
  await tools.create_map_local({
    rule_id: 'capped-query', url: `${origin}/v1/capped`, match_query: { late: 'yes' },
    status: 221, content_type: 'text/plain', body: 'capped-hit',
  });
  const filler = Array.from({ length: 1000 }, (_, index) => `k${index}=v`).join('&');
  const pastCap = `${origin}/v1/capped?${filler}&late=yes`;
  assert.equal((await requestViaProxy(engine.port, pastCap)).body.startsWith('upstream:'), true);
  assert.equal(engine.testRuleMatch('capped-query', { url: pastCap, method: 'GET' }).matched, false);
  // The cap is positional, not a size limit: the same 1001 parameters match
  // when 'late' is one of the first 1000, and both sides agree there too.
  const withinCap = `${origin}/v1/capped?late=yes&${filler}`;
  assert.equal((await requestViaProxy(engine.port, withinCap)).body, 'capped-hit');
  assert.equal(engine.testRuleMatch('capped-query', { url: withinCap, method: 'GET' }).matched, true);
});

test('capture_to_mock anchors the captured endpoint instead of every path containing it', async (t) => {
  let capturedBody = '{"marker":"captured"}';
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url === '/v1/users' ? capturedBody : JSON.stringify({ path: req.url }));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const engine = new ProxyEngine();
  await engine.start({ port: 0 });
  t.after(() => engine.stop());
  const tools = makeTools({ engine, pacServer: {}, mode: 'test' });
  const origin = `http://127.0.0.1:${upstreamPort}`;
  const escapedOrigin = origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/users`)).body, capturedBody);
  const { flows } = await tools.get_flows({ limit: 10 });
  const flow = flows.find((item) => item.url === `${origin}/v1/users`);
  const mock = await tools.capture_to_mock({ flow_id: flow.id, rule_id: 'captured-users' });

  // Live first, because pattern text alone proves nothing. A path that merely
  // contains the captured one is not mocked.
  capturedBody = '{"marker":"upstream-moved-on"}';
  const extended = await requestViaProxy(engine.port, `${origin}/x/v1/users/extra`);
  assert.equal(extended.body, JSON.stringify({ path: '/x/v1/users/extra' }));
  // Live: and neither is another host, which the unanchored pattern matched too
  // because a method-specific rule tests the path on its own.
  assert.equal((await requestViaProxy(engine.port, 'http://capture-anchor.invalid/x/v1/users/extra')).status, 502);
  assert.equal(engine.listRuleConfigs()[0].hit_count, 0);
  // Live: the captured endpoint itself is mocked, so it keeps answering the
  // captured body after upstream moves on.
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/users`)).body, '{"marker":"captured"}');
  assert.equal(engine.listRuleConfigs()[0].hit_count, 1);
  // The old builder produced the unanchored, host-less '/v1/users'.
  assert.equal(mock.url_pattern, `^${escapedOrigin}/v1/users$`);
  assert.equal(mock.match_query, null);

  // A captured query travels as match_query, like every other rule url: the
  // mock replays the request it was captured from, not the whole endpoint.
  await requestViaProxy(engine.port, `${origin}/v1/orders?page=2`);
  const paged = (await tools.get_flows({ limit: 10 })).flows.find((item) => item.url === `${origin}/v1/orders?page=2`);
  const pagedMock = await tools.capture_to_mock({ flow_id: paged.id, rule_id: 'captured-orders' });
  assert.deepEqual(pagedMock.match_query, { page: '2' });
  assert.equal(
    (await requestViaProxy(engine.port, `${origin}/v1/orders?page=2`)).body,
    JSON.stringify({ path: '/v1/orders?page=2' }),
  );
  assert.equal(
    (await requestViaProxy(engine.port, `${origin}/v1/orders?page=3`)).body,
    JSON.stringify({ path: '/v1/orders?page=3' }),
  );
  assert.equal(engine.listRuleConfigs().find((rule) => rule.rule_id === 'captured-orders').hit_count, 1);

  // A captured URL is text off the wire, not a glob: '*' has to stay literal or
  // the mock answers for paths the captured flow never touched. (The escapeRegex
  // this builder replaced escaped it correctly; urlPattern turned it into '.*'.)
  await requestViaProxy(engine.port, `${origin}/v1/a*b`);
  const starred = (await tools.get_flows({ limit: 50 })).flows.find((item) => item.url === `${origin}/v1/a*b`);
  const starMock = await tools.capture_to_mock({ flow_id: starred.id, rule_id: 'captured-star' });
  assert.equal(starMock.url_pattern, `^${escapedOrigin}/v1/a\\*b$`);
  // Live: as '.*' this pattern mocked /v1/aXXXb too, and the giveaway is the
  // body — the mock replays the captured '/v1/a*b' response for it.
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/aXXXb`)).body, JSON.stringify({ path: '/v1/aXXXb' }));
  assert.equal(engine.listRuleConfigs().find((rule) => rule.rule_id === 'captured-star').hit_count, 0);
  // Live: the captured path itself is still mocked.
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/a*b`)).body, JSON.stringify({ path: '/v1/a*b' }));
  assert.equal(engine.listRuleConfigs().find((rule) => rule.rule_id === 'captured-star').hit_count, 1);

  // A bound tripped on a derived query cannot be recovered from by shortening a
  // match_query the caller never supplied — capture_to_mock takes no such
  // argument. The hints have to name what the caller can actually change.
  const fatPath = `/v1/fat?k=${'v'.repeat(9000)}`;
  await requestViaProxy(engine.port, `${origin}${fatPath}`);
  const fat = (await tools.get_flows({ limit: 50 })).flows.find((item) => item.url === `${origin}${fatPath}`);
  await assert.rejects(
    tools.capture_to_mock({ flow_id: fat.id, rule_id: 'captured-fat' }),
    (error) => {
      assert.equal(error.code, 'QUERY_TOO_LARGE');
      assert.equal(error.retryable, false);
      assert.ok(error.recovery.every((hint) => !hint.includes('match_query')), error.recovery.join(' | '));
      assert.ok(error.recovery.some((hint) => /captur/i.test(hint)));
      assert.ok(error.recovery.some((hint) => hint.includes('url_pattern')));
      return true;
    },
  );
  assert.equal(engine.listRuleConfigs().some((rule) => rule.rule_id === 'captured-fat'), false);
});

test('update_rule retargets a rule through url instead of silently ignoring it', async (t) => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`upstream:${req.url}`);
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const engine = new ProxyEngine();
  await engine.start({ port: 0 });
  t.after(() => engine.stop());
  const tools = makeTools({ engine, pacServer: {}, mode: 'test' });
  const origin = `http://127.0.0.1:${upstreamPort}`;
  const escapedOrigin = origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  await tools.create_map_local({
    rule_id: 'retarget', url: `${origin}/v1/old`, status: 220, content_type: 'text/plain', body: 'mocked',
  });
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/old`)).body, 'mocked');

  // `url` is the documented friendly surface, so a patch that uses it has to
  // move the rule; it used to be merged, ignored, and reported as 'updated'.
  const patched = await tools.update_rule({ rule_id: 'retarget', patch: { url: `${origin}/v1/new?a=1` } });
  assert.equal(patched.status, 'updated');
  assert.equal(patched.rule.url_pattern, `^${escapedOrigin}/v1/new$`);
  assert.deepEqual(patched.rule.match_query, { a: '1' });
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/new?a=1`)).body, 'mocked');
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/old`)).body, 'upstream:/v1/old');
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/new?a=2`)).body, 'upstream:/v1/new?a=2');

  // Retargeting again drops the query the previous url left behind.
  const requeried = await tools.update_rule({ rule_id: 'retarget', patch: { url: `${origin}/v1/new` } });
  assert.equal(requeried.rule.match_query, null);
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/new?a=2`)).body, 'mocked');

  // An explicit url_pattern in the same patch still wins, as everywhere else.
  const overridden = await tools.update_rule({
    rule_id: 'retarget', patch: { url: `${origin}/v1/ignored`, url_pattern: `^${escapedOrigin}/v1/explicit$` },
  });
  assert.equal(overridden.rule.url_pattern, `^${escapedOrigin}/v1/explicit$`);
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/explicit`)).body, 'mocked');
  assert.equal((await requestViaProxy(engine.port, `${origin}/v1/ignored`)).body, 'upstream:/v1/ignored');
});

test('an empty or prototype-shaped match_json_body_including is refused or kept, never widened to every JSON body', async (t) => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`upstream:${req.url}`);
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const engine = new ProxyEngine();
  await engine.start({ port: 0 });
  t.after(() => engine.stop());
  const tools = makeTools({ engine, pacServer: {}, mode: 'test' });
  const origin = `http://127.0.0.1:${upstreamPort}`;
  const postJson = (path, payload) => requestViaProxy(engine.port, `${origin}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });

  const server = new McpServer({ name: 'proxy-mate-test', version: '0.0.0' });
  registerMcpTools(server, async (name, args) => tools[name](args));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'proxy-mate-test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(() => client.close());

  // Unchanged contract: still what z.record(z.string(), z.any()) advertised.
  const listed = await client.listTools();
  const advertised = listed.tools.find((tool) => tool.name === 'create_map_local').inputSchema;
  assert.deepEqual(advertised.properties.match_json_body_including, {
    type: 'object', propertyNames: { type: 'string' }, additionalProperties: {},
  });

  // mockttp compiles this to a JsonBodyFlexibleMatcher, which is _.isMatch, so
  // a key dropped at the root widens the rule the same way a query or header
  // key does. JSON.parse is what puts '__proto__' on the wire as an own key.
  const args = JSON.parse(`{
    "rule_id": "proto-body", "url": "${origin}/v1/b",
    "match_json_body_including": {"__proto__": "evil", "action": "checkout"},
    "status": 297, "content_type": "text/plain", "body": "body-hit"
  }`);
  assert.deepEqual(Object.keys(args.match_json_body_including), ['__proto__', 'action']);
  const created = await client.callTool({ name: 'create_map_local', arguments: args });
  assert.equal(created.isError, undefined, JSON.stringify(created.structuredContent?.error));
  const registered = engine.listRuleConfigs().find((rule) => rule.rule_id === 'proto-body');
  assert.deepEqual(Object.keys(registered.match_json_body_including), ['__proto__', 'action']);
  assert.equal({}.evil, undefined);
  await tools.remove_rule({ rule_id: 'proto-body' });

  // A field the wire can carry still matches only the bodies that include it.
  await tools.create_map_local({
    rule_id: 'named-field', url: `${origin}/v1/n`,
    match_json_body_including: { action: 'checkout' },
    status: 296, content_type: 'text/plain', body: 'field-hit',
  });
  assert.equal((await postJson('/v1/n', { action: 'checkout', extra: 1 })).body, 'field-hit');
  assert.equal((await postJson('/v1/n', { action: 'browse' })).body, 'upstream:/v1/n');
  await tools.remove_rule({ rule_id: 'named-field' });

  // The other half: an empty object is the absence of a constraint, so a
  // blacklist meant for one payload would block every JSON body on the path.
  const collapsed = {};
  collapsed['__proto__'] = 'evil';
  assert.deepEqual(Object.keys(collapsed), []);
  await assert.rejects(
    tools.create_blacklist({
      rule_id: 'empty-body', url: `${origin}/v1/only`, match_json_body_including: collapsed,
      status: 403, body_inline: 'denied',
    }),
    (error) => {
      assert.equal(error.code, 'MATCH_JSON_BODY_EMPTY');
      assert.equal(error.retryable, false);
      assert.ok(error.recovery.length > 0);
      return true;
    },
  );
  assert.deepEqual(engine.listRuleConfigs(), []);
  // Live: nothing registered, so every JSON body still reaches upstream.
  assert.equal((await postJson('/v1/only', { action: 'checkout' })).body, 'upstream:/v1/only');
  assert.equal((await postJson('/v1/only', { anything: true })).body, 'upstream:/v1/only');

  await assert.rejects(
    tools.create_map_local({ rule_id: 'bad-body', url: `${origin}/v1/bad`, match_json_body_including: 'action=checkout' }),
    (error) => error.code === 'MATCH_JSON_BODY_INVALID' && error.retryable === false,
  );
  assert.deepEqual(engine.listRuleConfigs(), []);
});
