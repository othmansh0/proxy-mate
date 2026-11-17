import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';

// Exercise the exported timer factory without starting the executable stdio
// bridge. All transport, clock and lifecycle inputs are explicit dependencies.
const source = await readFile(new URL('../src/client.mjs', import.meta.url), 'utf8');
const factory = source.slice(source.indexOf('export function createBridgeHeartbeat')).replace(/^export /, '');

test('bridge heartbeat starts after contact, uses cached readiness, catches failures, stops on stdin close', async () => {
  assert.match(factory, /^function createBridgeHeartbeat/);
  const create = new Function('readHandshake', 'SERVER_VERSION', `return (${factory});`)(null, 'test');
  const stdin = new EventEmitter(), timers = new Map();
  let next = 0, unrefs = 0, sent = [], successes = 0;
  const cached = { token: 'test', controlUrl: 'http://127.0.0.1:1' };
  const beat = create({ client: { client_id: 'client-a' }, stdin, read: async () => cached,
    readiness: { recordSuccess: () => successes++ }, random: () => 0,
    setTimer: (fn, ms) => { assert.ok(ms >= 27000 && ms <= 33000); const id = ++next; timers.set(id, fn); return { id, unref: () => unrefs++ }; },
    clearTimer: timer => timers.delete(timer.id),
    send: async (hs, client) => { sent.push({ hs, client }); if (sent.length === 2) throw new Error('offline'); return { interval_ms: 30000 }; },
  });
  assert.equal(timers.size, 0);
  beat.contact(cached); assert.equal(timers.size, 1);
  const fire = async () => { const [id, fn] = timers.entries().next().value; timers.delete(id); await fn(); };
  await fire(); assert.equal(sent.length, 1); assert.equal(successes, 2);
  await fire(); assert.equal(beat.failures, 1); assert.equal(timers.size, 1);
  assert.equal(unrefs, 3);
  stdin.emit('close'); assert.equal(timers.size, 0);
  beat.contact(cached); assert.equal(timers.size, 0);
  assert.match(source, /heartbeat\.stop\(\)/);
});
