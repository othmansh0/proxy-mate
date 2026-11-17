import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutingClaimsStore, unionDomains, nextExpiry } from '../src/lib/routing-claims.mjs';

async function store(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'routing-claims-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, claims: createRoutingClaimsStore({ directory, now: () => 1000 }) };
}
test('claims persist, serialize concurrent writes, normalize domains and renew only their owner', async (t) => {
  const { claims, directory } = await store(t);
  await Promise.all([
    claims.upsertClaim({ client_id: 'client-a', domains: ['A.TEST', 'a.test'], durationSeconds: 2 }),
    claims.upsertClaim({ client_id: 'client-b', task_id: 'task', domains: ['b.test'], durationSeconds: 10 }),
  ]);
  await claims.renewClaimsForClient('client-a', { now: 2000 });
  const rows = await claims.listClaims({ now: 3000 });
  assert.equal(rows.length, 2);
  assert.equal(rows.find(c => c.client_id === 'client-a').expires_at, new Date(4000).toISOString());
  assert.equal(rows.find(c => c.client_id === 'client-b').expires_at, new Date(11000).toISOString());
  assert.deepEqual(unionDomains(rows), ['a.test', 'b.test']);
  assert.equal(nextExpiry(rows), new Date(4000).toISOString());
  assert.equal((await fs.stat(path.join(directory, 'routing-claims.json'))).mode & 0o777, 0o600);
  assert.equal((await createRoutingClaimsStore({ directory }).listClaims({ now: 3000 })).length, 2);
  assert.equal((await claims.sweepExpired({ now: 4000 })).expired.length, 1);
  assert.equal((await claims.listClaims({ now: 4000 })).length, 1);
});
test('corrupt stores fail closed and preserve original bytes before replacement', async (t) => {
  const { claims, directory } = await store(t);
  await fs.writeFile(path.join(directory, 'routing-claims.json'), 'broken');
  const rows = await claims.listClaims();
  assert.equal(rows.length, 0); assert.equal(rows.corrupt, true);
  await claims.upsertClaim({ client_id: 'client-a', domains: ['a.test'], durationSeconds: 1 });
  const backup = (await fs.readdir(directory)).find(n => n.includes('.corrupt-'));
  assert.equal(await fs.readFile(path.join(directory, backup), 'utf8'), 'broken');
});
test('claim validation preserves broad consent, duration and union limits', async (t) => {
  const { claims } = await store(t);
  for (const durationSeconds of [0, 86401, 1.5]) await assert.rejects(claims.upsertClaim({ client_id: 'a', domains: ['a.test'], durationSeconds }), { code: 'ROUTING_LEASE_INVALID' });
  await assert.rejects(claims.upsertClaim({ client_id: 'a', domains: ['*'], durationSeconds: 1 }), { code: 'BROAD_ROUTING_REQUIRES_CONSENT' });
  await claims.upsertClaim({ client_id: 'a', domains: ['*'], allowBroad: true, durationSeconds: 1 });
  await claims.removeAllClaims();
  for (let i = 0; i < 4; i++) await claims.upsertClaim({ client_id: `c${i}`, domains: Array.from({ length: 64 }, (_, j) => `d${i * 64 + j}.test`), durationSeconds: 1 });
  await assert.rejects(claims.upsertClaim({ client_id: 'extra', domains: ['extra.test'], durationSeconds: 1 }), { code: 'ROUTING_UNION_LIMIT' });
  assert.equal((await claims.listClaims()).length, 4);
});

test('task keys update in place and removal by id preserves sibling tasks', async (t) => {
  const { claims } = await store(t);
  const first = await claims.upsertClaim({ client_id: 'a', task_id: 'one', domains: ['one.test'], durationSeconds: 10 });
  const updated = await claims.upsertClaim({ client_id: 'a', task_id: 'one', domains: ['updated.test'], durationSeconds: 10 });
  assert.equal(updated.claim_id, first.claim_id);
  await claims.upsertClaim({ client_id: 'a', task_id: 'two', domains: ['two.test'], durationSeconds: 10 });
  await claims.removeClaim({ claim_id: first.claim_id });
  assert.equal((await claims.listClaims())[0].task_id, 'two');
  await claims.removeClaim({ client_id: 'a', task_id: 'two' });
  assert.deepEqual(await claims.listClaims(), []);
  assert.equal(nextExpiry([]), null);
});
test('unreadable and malformed files never throw from listClaims', async (t) => {
  const { directory } = await store(t);
  const claims = createRoutingClaimsStore({ directory, fs: { readFile: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } } });
  assert.equal((await claims.listClaims()).corrupt, true);
  await fs.writeFile(path.join(directory, 'routing-claims.json'), JSON.stringify({ version: 1, claims: [{}] }));
  assert.equal((await createRoutingClaimsStore({ directory }).listClaims()).corrupt, true);
});
test('renewal leaves expired client claims expired', async (t) => {
  const { claims } = await store(t);
  await claims.upsertClaim({ client_id: 'a', domains: ['a.test'], durationSeconds: 1 });
  await claims.upsertClaim({ client_id: 'b', domains: ['b.test'], durationSeconds: 10 });
  await claims.renewClaimsForClient('a', { now: 3000 });
  assert.equal((await claims.listClaims({ now: 3000 })).length, 1);
});
