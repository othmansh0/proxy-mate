import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRedactionConfig,
  createRedactor,
  previewRedaction,
  redactUrl,
} from '../src/lib/redaction.mjs';

test('redaction configuration adds safe glob patterns without weakening defaults', () => {
  const config = createRedactionConfig({
    headerPatterns: ['x-company-*'],
    queryPatterns: ['private_*'],
    bodyFieldPatterns: ['customer?secret'],
    env: { PROXY_MATE_REDACT_HEADERS: 'x-env-secret' },
  });
  const preview = previewRedaction({
    url: '/items?token=default&private_id=42&safe=yes',
    headers: { authorization: 'default', 'x-company-key': 'custom', 'x-env-secret': 'env', accept: 'text/plain' },
    body: JSON.stringify({ password: 'default', customer_secret: 'custom', safe: true }),
  }, config);

  assert.equal(new URL(preview.url, 'http://local').searchParams.get('token'), '[REDACTED]');
  assert.equal(new URL(preview.url, 'http://local').searchParams.get('private_id'), '[REDACTED]');
  assert.equal(preview.headers.authorization, '[REDACTED]');
  assert.equal(preview.headers['x-company-key'], '[REDACTED]');
  assert.equal(preview.headers['x-env-secret'], '[REDACTED]');
  assert.equal(JSON.parse(preview.body).password, '[REDACTED]');
  assert.equal(JSON.parse(preview.body).customer_secret, '[REDACTED]');
  assert.ok(preview.redacted_fields.length >= 6);
});

test('redaction preview API is reusable and rejects executable or excessive patterns', () => {
  const redactor = createRedactor({ queryPatterns: ['credential-*'], env: {} });
  assert.equal(
    new URL(redactor.redactUrl('https://example.test/?credential-id=secret')).searchParams.get('credential-id'),
    '[REDACTED]',
  );
  assert.match(redactor.preview({ headers: { cookie: 'private' } }).headers.cookie, /REDACTED/);
  assert.throws(() => createRedactionConfig({ headerPatterns: ['(a+)+'], env: {} }), /letters, digits/i);
  assert.throws(() => createRedactionConfig({ queryPatterns: Array(65).fill('field'), env: {} }), /at most 64/);
  assert.match(redactUrl('/relative?password=secret'), /%5BREDACTED%5D/);
});
