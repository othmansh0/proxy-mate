import test from 'node:test';
import assert from 'node:assert/strict';

import {
  diffFlows, generateRequestCode, generateSwiftUrlSession, parseCurlCommand,
} from '../src/lib/request-tools.mjs';

test('Swift URLSession generation omits captured credentials', () => {
  const generated = generateSwiftUrlSession({ request: {
    method: 'POST', url: 'https://api.example.test/items',
    headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
    body_inline: '{"name":"test"}',
  } });
  assert.match(generated.code, /URLSession\.shared\.data/);
  assert.doesNotMatch(generated.code, /Bearer secret/);
  assert.deepEqual(generated.redacted_headers, ['authorization']);
});

test('flow diff reports semantic request and response changes', () => {
  const left = { request: { method: 'GET', url: 'https://example.test/a', headers: {}, body_sha: 'a' }, response: { statusCode: 200, headers: {}, body_sha: 'b' } };
  const right = { request: { method: 'POST', url: 'https://example.test/a', headers: {}, body_sha: 'a' }, response: { statusCode: 503, headers: {}, body_sha: 'c' } };
  const result = diffFlows(left, right);
  assert.equal(result.equal, false);
  assert.deepEqual(result.changes.map((change) => change.field), ['request.method', 'response.status', 'response.body_sha']);
});

test('cURL import parses quoted request data without executing shell syntax', () => {
  const request = parseCurlCommand("curl -X POST 'https://api.example.test/items?q=1' -H 'content-type: application/json' -H 'x-test: yes' --data-raw '{\"name\":\"Ada\"}'");
  assert.deepEqual(request, {
    method: 'POST', url: 'https://api.example.test/items?q=1',
    headers: { 'content-type': 'application/json', 'x-test': 'yes' }, body: '{"name":"Ada"}',
  });
  assert.throws(() => parseCurlCommand('curl https://example.test --config dangerous'), (error) => error.code === 'CURL_OPTION_UNSUPPORTED');
});

test('request code generation supports common clients and removes credentials', () => {
  const flow = { request: { method: 'POST', url: 'https://api.example.test/items', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body_inline: '{"ok":true}' } };
  for (const language of ['javascript', 'python', 'go', 'swift']) {
    const generated = generateRequestCode(flow, language);
    assert.doesNotMatch(generated.code, /Bearer secret/);
    assert.ok(generated.redacted_headers.includes('authorization'));
  }
});
