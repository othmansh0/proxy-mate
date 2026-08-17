import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeFlows, evaluateCaptureAssertions } from '../src/lib/analytics.mjs';

const flows = [
  { id: 'a', request: { method: 'GET', url: 'https://api.test/users/123' }, response: { statusCode: 200, body_size: 10 }, duration_ms: 50 },
  { id: 'b', request: { method: 'GET', url: 'https://api.test/users/456' }, response: { statusCode: 503, body_size: 20 }, duration_ms: 200 },
  { id: 'c', request: { method: 'POST', url: 'https://api.test/orders/550e8400-e29b-41d4-a716-446655440000' }, response: { statusCode: 201, body_size: 30 }, duration_ms: 100 },
];

test('capture analytics groups dynamic routes and reports failures and latency', () => {
  const result = analyzeFlows(flows);
  assert.equal(result.flow_count, 3);
  assert.equal(result.failure_count, 1);
  assert.equal(result.response_bytes, 60);
  assert.equal(result.endpoints[0].endpoint, 'GET api.test/users/:id');
  assert.equal(result.endpoints[0].count, 2);
  assert.equal(result.endpoints[0].p95_ms, 200);
  assert.equal(result.slowest[0].flow_id, 'b');
});

test('capture assertions provide deterministic CI pass and failure details', () => {
  const analysis = analyzeFlows(flows);
  const result = evaluateCaptureAssertions(analysis, {
    min_flows: 3, max_failures: 0, max_p95_ms: 250, allowed_statuses: [200, 201],
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.failed.map((entry) => entry.assertion), ['max_failures', 'allowed_statuses']);
});
