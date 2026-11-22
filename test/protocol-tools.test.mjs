import test from 'node:test';
import assert from 'node:assert/strict';

import { makeTools } from '../src/lib/tools.mjs';

test('protocol inspection redacts GraphQL variables and gates binary payload decoding', async () => {
  const previous = process.env.PROXYFAN_ALLOW_SENSITIVE;
  delete process.env.PROXYFAN_ALLOW_SENSITIVE;
  const graphql = {
    id: 'graphql-flow',
    request: {
      headers: { 'content-type': 'application/json' },
      body_inline: JSON.stringify({
        operationName: 'Login',
        query: 'mutation Login($password: String!) { login(password: $password) }',
        variables: { password: 'private', safe: 'visible' },
      }),
    },
  };
  const grpcPayload = Buffer.concat([Buffer.from([0, 0, 0, 0, 3]), Buffer.from([1, 2, 3])]);
  const engine = {
    diagnostics: [], maxDiagnostics: 100,
    async getDurableFlow(flowId) {
      if (flowId === 'graphql-flow') return graphql;
      return {
        id: 'grpc-flow',
        response: {
          headers: { 'content-type': 'application/grpc' },
          body_base64: grpcPayload.toString('base64'),
          body_inline: grpcPayload.toString('binary'),
        },
      };
    },
  };
  const tools = makeTools({ engine, pacServer: {} });
  try {
    const result = await tools.inspect_flow_protocol({ flow_id: 'graphql-flow', kind: 'req', format: 'graphql' });
    assert.equal(result.redacted, true);
    assert.equal(result.operations[0].variables.password, '[REDACTED]');
    assert.equal(result.operations[0].variables.safe, 'visible');
    await assert.rejects(
      tools.inspect_flow_protocol({ flow_id: 'grpc-flow', kind: 'res', format: 'grpc' }),
      (error) => error.code === 'SENSITIVE_ACCESS_REQUIRED',
    );
  } finally {
    if (previous == null) delete process.env.PROXYFAN_ALLOW_SENSITIVE;
    else process.env.PROXYFAN_ALLOW_SENSITIVE = previous;
  }
});
