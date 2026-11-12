import test from 'node:test';
import assert from 'node:assert/strict';
import { upstreamErrorDiagnostic, upstreamErrorFromTags, upstreamErrorTags } from '../src/lib/upstream-errors.mjs';

test('upstream diagnostics retain machine codes without retaining error content or untrusted tags', () => {
  const record = upstreamErrorDiagnostic({
    eventType: 'passthrough-abort', requestId: 'flow-1',
    eventData: { downstreamAborted: false,
      tags: ['user-secret', ['passthrough-error:ETIMEDOUT'], 'passthrough-error:Bearer secret'],
      error: { name: 'AggregateError', code: 'ETIMEDOUT', message: 'password=secret', stack: 'Bearer secret' },
      rawBody: 'secret', headers: { authorization: 'secret' },
    },
  });
  assert.equal(record.id, 'flow-1');
  assert.equal(record.code, 'ETIMEDOUT');
  assert.equal(record.error_name, 'AggregateError');
  assert.deepEqual(record.tags, ['passthrough-error:ETIMEDOUT']);
  assert.equal(JSON.stringify(record).includes('secret'), false);
  for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT']) {
    assert.equal(upstreamErrorFromTags([`passthrough-error:${code}`]).code, code);
  }
  assert.deepEqual(upstreamErrorTags(['passthrough-error:ECONNRESET', 'passthrough-error:ECONNRESET']), ['passthrough-error:ECONNRESET']);
});

test('downstream cancellation and unrelated rule events are not upstream faults', () => {
  assert.equal(upstreamErrorDiagnostic({ eventType: 'passthrough-abort', requestId: 'id', eventData: { downstreamAborted: true } }), null);
  assert.equal(upstreamErrorDiagnostic({ eventType: 'passthrough-response-head', requestId: 'id' }), null);
  assert.equal(upstreamErrorDiagnostic({ eventType: 'passthrough-abort', requestId: 'https://user:secret@example.test' }), null);
  assert.equal(upstreamErrorFromTags(['arbitrary', 'passthrough-error:mockttp-abort']), null);
  assert.equal(upstreamErrorDiagnostic({ eventType: 'passthrough-abort', requestId: 'id', eventData: { error: { code: 'password=secret' } } }).code, 'UPSTREAM_CONNECTION_FAILED');
});
