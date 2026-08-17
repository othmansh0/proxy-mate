import test from 'node:test';
import assert from 'node:assert/strict';

import { loadOpenApiDocument, resolveOpenApiReferences, validateOpenApiFlow, validateOpenApiFlows } from '../src/lib/openapi.mjs';

const document = {
  openapi: '3.0.3',
  paths: {
    '/pets/mine': { get: { operationId: 'myPets', responses: { '200': { description: 'ok' } } } },
    '/pets/{petId}': {
      parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        operationId: 'getPet',
        parameters: [{ name: 'include', in: 'query', required: true }, { name: 'X-Tenant', in: 'header', required: true }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'count'], properties: { name: { type: 'string' }, count: { type: 'integer' } } } } } },
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } } } } },
      },
    },
  },
};

function flow(overrides = {}) {
  return {
    request: { method: 'GET', url: 'https://api.example.test/pets/42?include=owner', headers: { 'content-type': 'application/json', 'x-tenant': 'ios' }, body_inline: '{"name":"Ada","count":2}' },
    response: { statusCode: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body_inline: '{"id":42}' },
    ...overrides,
  };
}

test('matches a captured flow, parameters, request schema, and response schema', () => {
  const result = validateOpenApiFlow(document, flow());
  assert.equal(result.valid, true);
  assert.equal(result.matched, true);
  assert.equal(result.operation_id, 'getPet');
  assert.equal(result.path_template, '/pets/{petId}');
  assert.deepEqual(result.errors, []);
});

test('prefers an exact OpenAPI path over a templated path', () => {
  const result = validateOpenApiFlow(document, { request: { method: 'GET', url: 'https://api.example.test/pets/mine' }, response: { statusCode: 200 } });
  assert.equal(result.operation_id, 'myPets');
  assert.equal(result.path_template, '/pets/mine');
});

test('returns machine-readable contract errors without throwing', () => {
  const invalid = flow({
    request: { method: 'GET', url: 'https://api.example.test/pets/42', headers: { 'content-type': 'application/json' }, body_inline: '{"name":4}' },
    response: { statusCode: 201, headers: { 'content-type': 'text/plain' }, body_inline: 'created' },
  });
  const result = validateOpenApiFlow(document, invalid);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((entry) => entry.code === 'OPENAPI_REQUIRED_PARAMETER_MISSING'));
  assert.ok(result.errors.some((entry) => entry.code === 'OPENAPI_SCHEMA_TYPE_MISMATCH'));
  assert.ok(result.errors.some((entry) => entry.code === 'OPENAPI_SCHEMA_REQUIRED_PROPERTY_MISSING'));
  assert.ok(result.errors.some((entry) => entry.code === 'OPENAPI_RESPONSE_STATUS_UNDECLARED'));
});

test('reports unsupported schema features and malformed/oversized documents safely', () => {
  const refDocument = { openapi: '3.1.0', paths: { '/x': { get: { responses: { '200': { description: 'ok', content: { 'application/json': { schema: { oneOf: [{ type: 'string' }] } } } } } } } } };
  const result = validateOpenApiFlow(refDocument, { request: { method: 'GET', url: 'https://example.test/x' }, response: { statusCode: 200, headers: { 'content-type': 'application/json' }, body_inline: '"x"' } });
  assert.ok(result.unsupported.includes('OPENAPI_SCHEMA_ONEOF_UNSUPPORTED'));
  assert.equal(loadOpenApiDocument('openapi: 3.0.0').errors[0].code, 'OPENAPI_JSON_REQUIRED');
  assert.equal(loadOpenApiDocument(document, { maxBytes: 20 }).errors[0].code, 'OPENAPI_DOCUMENT_TOO_LARGE');
});

test('resolves local/external JSON refs without network access and validates common schema bounds', () => {
  const referenced = { openapi: '3.0.3', paths: { '/x': { get: { responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: 'common.json#/Thing' } } } } } } } } };
  const external = { Thing: { type: 'array', minItems: 2, uniqueItems: true, items: { type: 'integer', minimum: 1 } } };
  const loaded = loadOpenApiDocument(referenced, { externalDocuments: { 'common.json': external } });
  assert.equal(loaded.ok, true);
  const result = validateOpenApiFlow(loaded.document, { request: { method: 'GET', url: 'https://example.test/x' }, response: { statusCode: 200, headers: { 'content-type': 'application/json' }, body_inline: '[1,1]' } });
  assert.ok(result.errors.some((entry) => entry.code === 'OPENAPI_SCHEMA_UNIQUE_ITEMS'));
  const short = validateOpenApiFlow(loaded.document, { request: { method: 'GET', url: 'https://example.test/x' }, response: { statusCode: 200, headers: { 'content-type': 'application/json' }, body_inline: '[1]' } });
  assert.ok(short.errors.some((entry) => entry.code === 'OPENAPI_SCHEMA_MIN_ITEMS'));
  assert.equal(resolveOpenApiReferences(referenced).errors[0].code, 'OPENAPI_REFERENCE_UNRESOLVED');
});

test('validates bounded flow batches with compact body-free failures', () => {
  const invalid = flow({ request: { method: 'GET', url: 'https://api.example.test/missing', body_inline: 'secret body' } });
  const batch = validateOpenApiFlows(document, [flow(), invalid, flow()], { maxFlows: 2 });
  assert.deepEqual(batch.counts, { valid: 1, invalid: 1, unmatched: 1, unsupported: 0 });
  assert.equal(batch.processed, 2); assert.equal(batch.total, 3); assert.equal(batch.truncated, true); assert.equal(batch.valid, false);
  assert.equal(batch.failures[0].errors[0].code, 'OPENAPI_PATH_NOT_FOUND');
  assert.equal(JSON.stringify(batch.failures).includes('secret body'), false);
});
