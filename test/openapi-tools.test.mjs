import test from 'node:test';
import assert from 'node:assert/strict';

import { makeTools } from '../src/lib/tools.mjs';

const document = {
  openapi: '3.0.3',
  paths: {
    '/items/{id}': {
      get: {
        operationId: 'getItem',
        parameters: [{ name: 'id', in: 'path', required: true }],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', required: ['id'] } } } } },
      },
    },
  },
};

test('validate_flow_openapi resolves a durable flow and returns bounded structured validation', async () => {
  const engine = {
    sessionId: 'ios-debug', diagnostics: [], maxDiagnostics: 100,
    async getDurableFlow(flowId, sessionId) {
      assert.equal(flowId, 'flow-1');
      assert.equal(sessionId, 'ios-debug');
      return {
        id: 'flow-1', request: { method: 'GET', url: 'https://api.example.test/items/42', headers: {} },
        response: { statusCode: 200, headers: { 'content-type': 'application/json' }, body_inline: '{"id":42}' },
      };
    },
  };
  const tools = makeTools({ engine, pacServer: {} });
  const result = await tools.validate_flow_openapi({
    flow_id: 'flow-1', session_id: 'ios-debug', document,
    max_document_bytes: 1024 * 1024, max_body_bytes: 1024,
  });
  assert.equal(result.valid, true);
  assert.equal(result.operation_id, 'getItem');
  assert.deepEqual(result.limits, { max_document_bytes: 1024 * 1024, max_body_bytes: 1024 });
  assert.equal(result.document_source, 'inline');
});

test('validate_flow_openapi requires exactly one document source', async () => {
  const tools = makeTools({ engine: { diagnostics: [], maxDiagnostics: 100 }, pacServer: {} });
  await assert.rejects(
    tools.validate_flow_openapi({ flow_id: 'flow-1' }),
    (error) => error.code === 'OPENAPI_DOCUMENT_SOURCE_REQUIRED',
  );
});

test('validate_capture_openapi returns bounded body-free session results', async () => {
  const flows = [
    {
      id: 'flow-1', request: { method: 'GET', url: 'https://api.example.test/items/42', headers: {} },
      response: { statusCode: 200, headers: { 'content-type': 'application/json' }, body_inline: '{"id":42}' },
    },
    {
      id: 'flow-2', request: { method: 'GET', url: 'https://api.example.test/unknown', headers: {} },
      response: { statusCode: 404, headers: {}, body_inline: 'secret payload must not be reported' },
    },
  ];
  const engine = {
    sessionId: 'ios-debug', diagnostics: [], maxDiagnostics: 100,
    sessionStore: {
      async listFlows({ sessionId, limit }) {
        assert.equal(sessionId, 'ios-debug');
        assert.equal(limit, 2);
        return { flows, has_more: true, session: { flow_count: 7 } };
      },
    },
  };
  const tools = makeTools({ engine, pacServer: {} });
  const result = await tools.validate_capture_openapi({ document, max_flows: 2 });
  assert.equal(result.processed, 2);
  assert.equal(result.total, 7);
  assert.equal(result.truncated, true);
  assert.equal(result.skipped_count, 5);
  assert.deepEqual(result.counts, { valid: 1, invalid: 1, unmatched: 1, unsupported: 0 });
  assert.equal(JSON.stringify(result.failures).includes('secret payload'), false);
});
