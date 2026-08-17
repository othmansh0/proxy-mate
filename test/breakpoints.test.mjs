import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BreakpointError,
  BreakpointManager,
  createMockttpBreakpointCallbacks,
} from '../src/lib/breakpoints.mjs';

function makeManager(options = {}) {
  return new BreakpointManager({
    defaultTimeoutMs: 1_000,
    maxTimeoutMs: 2_000,
    idFactory: ({ sequence }) => `bp-${sequence}`,
    ...options,
  });
}

function request(overrides = {}) {
  return {
    id: 'request-1',
    method: 'POST',
    url: 'https://api.example.test/users?token=query-secret&safe=yes',
    protocol: 'https',
    httpVersion: '1.1',
    headers: {
      authorization: 'Bearer header-secret',
      cookie: 'sid=cookie-secret',
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: { buffer: Buffer.from(JSON.stringify({ password: 'body-secret', name: 'Ada' })) },
    ...overrides,
  };
}

test('concurrent pauses have stable IDs and resolve independently out of order', async () => {
  const manager = makeManager();
  const firstPromise = manager.pause({ ruleId: 'rule-a', direction: 'request', message: request() });
  const secondPromise = manager.pause({
    ruleId: 'rule-b',
    direction: 'response',
    message: {
      request: request(),
      response: { id: 'request-1', statusCode: 200, headers: { 'content-type': 'text/plain' }, body: { buffer: Buffer.from('ok') } },
    },
  });

  assert.deepEqual(manager.listPending().map(({ id }) => id), ['bp-1', 'bp-2']);
  assert.equal(manager.getPending('bp-1').id, 'bp-1');
  assert.equal(manager.getPending('bp-2').direction, 'response');

  manager.resolve('bp-2', { action: 'modify', changes: { status: 202, headers: { 'x-edited': 'yes' }, json: { accepted: true } } });
  manager.resolve('bp-1', { action: 'modify', changes: { method: 'patch', url: 'https://api.example.test/edited', body: 'changed' } });

  assert.deepEqual(await secondPromise, {
    statusCode: 202,
    headers: { 'x-edited': 'yes' },
    json: { accepted: true },
  });
  assert.deepEqual(await firstPromise, {
    method: 'PATCH',
    url: 'https://api.example.test/edited',
    body: 'changed',
  });
  assert.equal(manager.listPending().length, 0);
  assert.deepEqual(manager.getHistory().map(({ id, outcome, action }) => [id, outcome, action]), [
    ['bp-2', 'resolved', 'modify'],
    ['bp-1', 'resolved', 'modify'],
  ]);
});

test('actions map exactly to Mockttp beforeRequest and beforeResponse callback results', async () => {
  const manager = makeManager();
  const callbacks = createMockttpBreakpointCallbacks(manager, { ruleId: 'breakpoint-rule' });

  const responsePromise = callbacks.beforeRequest(request());
  manager.resolve('bp-1', { action: 'respond', response: { statusCode: 418, headers: { 'content-type': 'text/plain' }, body: 'teapot' } });
  assert.deepEqual(await responsePromise, {
    response: { statusCode: 418, headers: { 'content-type': 'text/plain' }, body: 'teapot' },
  });

  const abortRequest = callbacks.beforeRequest(request());
  manager.resolve('bp-2', { action: 'abort' });
  assert.equal((await abortRequest).response.statusCode, 503);

  const closeRequest = callbacks.beforeRequest(request());
  manager.resolve('bp-3', { action: 'close' });
  assert.deepEqual(await closeRequest, { response: 'close' });

  const resetResponse = callbacks.beforeResponse(
    { statusCode: 200, headers: {}, body: { buffer: Buffer.alloc(0) } },
    request(),
  );
  manager.resolve('bp-4', { action: 'reset' });
  assert.equal(await resetResponse, 'reset');

  const continueResponse = callbacks.beforeResponse({ statusCode: 204, headers: {} }, request());
  manager.resolve('bp-5', { action: 'continue' });
  assert.deepEqual(await continueResponse, {});
});

test('deadlines apply a deterministic fallback and preserve structured outcome history', async () => {
  const manager = makeManager({ defaultTimeoutMs: 20, defaultAction: 'abort' });
  const paused = manager.pause({ ruleId: 'slow-rule', direction: 'request', message: request() });

  const result = await paused;
  assert.equal(result.response.statusCode, 503);
  assert.equal(manager.listPending().length, 0);
  const [history] = manager.getHistory();
  assert.equal(history.id, 'bp-1');
  assert.equal(history.outcome, 'timed_out');
  assert.equal(history.action, 'abort');
  assert.equal(history.defaulted, true);
  assert.match(history.reason, /deadline elapsed/i);
  assert.ok(history.completed_at);
  assert.ok(history.duration_ms >= 0);
  assert.throws(() => manager.resolve('bp-1'), (error) => error instanceof BreakpointError && error.code === 'BREAKPOINT_NOT_PENDING');
});

test('pending snapshots default to redacted and require explicit per-read sensitive opt-in', async () => {
  const manager = makeManager();
  const paused = manager.pause({ ruleId: 'redaction', direction: 'request', message: request() });
  const pending = manager.listPending()[0];

  assert.equal(pending.redacted, true);
  assert.match(pending.message.request.url, /token=%5BREDACTED%5D/);
  assert.equal(pending.message.request.headers.authorization, '[REDACTED]');
  assert.equal(pending.message.request.headers.cookie, '[REDACTED]');
  assert.deepEqual(JSON.parse(pending.message.request.body.preview), { password: '[REDACTED]', name: 'Ada' });
  pending.message.request.headers.authorization = 'mutated';
  assert.equal(manager.getPending('bp-1').message.request.headers.authorization, '[REDACTED]');
  assert.throws(
    () => manager.getPending('bp-1', { includeSensitive: true }),
    (error) => error.code === 'SENSITIVE_BREAKPOINT_ACCESS_NOT_GRANTED',
  );
  manager.resolve('bp-1');
  await paused;

  const trusted = makeManager({ allowSensitive: true });
  const trustedPause = trusted.pause({ ruleId: 'trusted', direction: 'request', message: request() });
  assert.equal(trusted.getPending('bp-1').redacted, true);
  assert.equal(trusted.getPending('bp-1').message.request.headers.authorization, '[REDACTED]');
  const exposed = trusted.getPending('bp-1', { includeSensitive: true });
  assert.equal(exposed.redacted, false);
  assert.equal(exposed.message.request.headers.authorization, 'Bearer header-secret');
  assert.match(exposed.message.request.url, /token=query-secret/);
  assert.match(exposed.message.request.body.preview, /body-secret/);
  trusted.resolve('bp-1');
  await trustedPause;
});

test('capacity never hangs traffic and closeAll safely resolves every pending pause', async () => {
  const manager = makeManager({ maxPending: 1, defaultAction: 'continue' });
  const first = manager.pause({ ruleId: 'capacity', direction: 'request', message: request() });
  const overflow = manager.pause({ ruleId: 'capacity', direction: 'request', message: request({ id: 'request-2' }) });
  assert.deepEqual(await overflow, {});
  assert.equal(manager.listPending().length, 1);
  assert.equal(manager.getHistory()[0].outcome, 'capacity_exceeded');

  const closed = manager.closeAll({ reason: 'proxy stopped', action: 'reset' });
  assert.equal(closed.closed_count, 1);
  assert.deepEqual(await first, { response: 'reset' });
  assert.equal(manager.listPending().length, 0);
  assert.equal(manager.getHistory().at(-1).outcome, 'closed');
});

test('invalid decisions are rejected while the breakpoint remains resolvable', async () => {
  const manager = makeManager({ maxBodyBytes: 4 });
  const paused = manager.pause({ ruleId: 'validation', direction: 'request', message: request() });

  assert.throws(
    () => manager.resolve('bp-1', { action: 'modify', changes: { method: 'bad method' } }),
    (error) => error.code === 'INVALID_BREAKPOINT_METHOD',
  );
  assert.throws(
    () => manager.resolve('bp-1', { action: 'modify', changes: { body: '12345' } }),
    (error) => error.code === 'BREAKPOINT_BODY_TOO_LARGE',
  );
  assert.throws(
    () => manager.resolve('bp-1', { action: 'respond', response: { statusCode: 700 } }),
    (error) => error.code === 'INVALID_BREAKPOINT_STATUS',
  );
  assert.equal(manager.getPending('bp-1').state, 'pending');
  manager.cancel('bp-1', { reason: 'test cleanup' });
  assert.deepEqual(await paused, {});
});
