import test from 'node:test';
import assert from 'node:assert/strict';
import { createClientRegistry } from '../src/lib/client-registry.mjs';

test('presence grace, threshold, one loss per absence, revival and legacy exclusion', async () => {
  let now = 0; const lost = [];
  const registry = createClientRegistry({ now: () => now, intervalMs: 10, missedBeats: 3,
    startupGraceMs: 100, onPresenceLost: c => lost.push(c) });
  registry.touch({ client_id: 'client-a', task_id: 'private' });
  registry.touch({ client_id: 'legacy' });
  now = 50; await registry.sweep(); assert.equal(lost.length, 0);
  assert.equal(registry.isAlive('client-a'), false);
  now = 101; await registry.sweep(); await registry.sweep(); assert.equal(lost.length, 1);
  registry.touch({ client_id: 'client-a' }); assert.equal(registry.isAlive('client-a'), true);
  now = 132; await registry.sweep(); assert.equal(lost.length, 2);
  assert.equal(registry.list().length, 1);
});

test('registry is bounded and evicts stale oldest before live clients', () => {
  let now = 0;
  const registry = createClientRegistry({ now: () => now, intervalMs: 10, missedBeats: 3 });
  for (let i = 0; i < 512; i++) registry.touch({ client_id: `client-${i}` });
  now = 40; registry.touch({ client_id: 'client-0' });
  registry.touch({ client_id: 'new-client' });
  assert.equal(registry.list().length, 512);
  assert.equal(registry.isAlive('client-0'), true);
  assert.ok(!registry.list().some(c => c.client_id === 'client-1'));
});
