import test from 'node:test';
import assert from 'node:assert/strict';

import { createGraphQLOperationMatcher, inspectGraphQLBody, parseGrpcFrames, ProtobufDescriptorCache, protocolCapabilities } from '../src/lib/protocols.mjs';

test('extracts GraphQL operation name, type, and variables', () => {
  const result = inspectGraphQLBody(JSON.stringify({
    operationName: 'UpdateUser',
    query: 'mutation UpdateUser($id: ID!) { updateUser(id: $id) { id } }',
    variables: { id: '123' },
  }));
  assert.equal(result.detected, true);
  assert.equal(result.operations[0].operation_type, 'mutation');
  assert.equal(result.operations[0].operation_name, 'UpdateUser');
  assert.deepEqual(result.operations[0].variables, { id: '123' });
});

test('parses gRPC message framing and reports truncation', () => {
  const payload = Buffer.from([8, 1]);
  const frame = Buffer.alloc(5 + payload.length);
  frame.writeUInt8(0, 0);
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  const parsed = parseGrpcFrames(frame);
  assert.equal(parsed.valid, true);
  assert.deepEqual(parsed.frames[0].payload, payload);
  assert.equal(parseGrpcFrames(frame.subarray(0, 6)).error.code, 'TRUNCATED_GRPC_MESSAGE');
});

test('handles GraphQL batches, anonymous operations, selected operation names, and reusable matchers', () => {
  const result = inspectGraphQLBody([{ query: 'query One { one } mutation Two { two }', operationName: 'Two', variables: { n: null } }, { query: '{ viewer { id } }' }]);
  assert.equal(result.batch, true);
  assert.equal(result.operations[0].operation_type, 'mutation');
  assert.equal(result.operations[0].operation_name, 'Two');
  assert.equal(result.operations[0].variables.n, null);
  assert.equal(result.operations[1].anonymous, true);
  assert.equal(createGraphQLOperationMatcher(/^T/)(result.operations[0]), true);
});

test('recognizes grpc-web trailer frames, compression metadata, and descriptor cache LRU', () => {
  const trailers = Buffer.from('grpc-status: 0\r\ngrpc-message: ok\r\n');
  const frame = Buffer.alloc(5 + trailers.length); frame[0] = 0x80; frame.writeUInt32BE(trailers.length, 1); trailers.copy(frame, 5);
  const parsed = parseGrpcFrames(frame, { contentEncoding: 'gzip' });
  assert.equal(parsed.grpc_web, true);
  assert.equal(parsed.frames[0].trailers['grpc-status'], '0');
  const cache = new ProtobufDescriptorCache({ maxEntries: 1 }); cache.set('/a', 'A'); cache.set('/b', 'B');
  assert.equal(cache.get('/a', 'A'), null); assert.equal(cache.get('/b', 'B').message_type, 'B');
});

test('returns a compact protocol capability descriptor', () => {
  const capabilities = protocolCapabilities();
  assert.equal(capabilities.graphql.batches, true);
  assert.equal(capabilities.websocket.live_frame_injection, false);
});
