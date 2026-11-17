import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as pac from '../src/lib/pac.mjs';
import { createRoutingClaimsStore } from '../src/lib/routing-claims.mjs';
import { STATE_DIR, patchState, readState, clearState } from '../src/lib/state.mjs';
import { reconcileRuntime } from '../src/lib/runtime.mjs';
import { createGuardian } from '../src/lib/guardian.mjs';

async function fixture(t) {
  // Only ever reset a temporary state directory, never a real installation.
  const real = ['.proxy-mcp', '.proxy-mate'].map((name) => path.join(os.homedir(), name));
  assert.ok(!real.includes(path.resolve(STATE_DIR)), `refusing to reset a real state directory: ${STATE_DIR}`);
  await fs.rm(STATE_DIR, { recursive: true, force: true });
  let auto = { enabled: false, url: '' }, port = 8000;
  const calls = [], events = [];
  const run = async (_file, args) => {
    calls.push(args);
    if (args[0] === '-getautoproxyurl') return { stdout: `URL: ${auto.url}\nEnabled: ${auto.enabled ? 'Yes' : 'No'}\n` };
    if (args[0] === '-setautoproxyurl') auto.url = args[2];
    if (args[0] === '-setautoproxystate') auto.enabled = args[2] === 'on';
    return { stdout: 'Enabled: No\n' };
  };
  const record = async (event, fields) => events.push({ event, ...fields });
  const claims = createRoutingClaimsStore();
  const server = { port: null, setBody(body) { this.body = body; }, async start() { this.port = 8081; }, async stop() { this.port = null; } };
  const controller = pac.createRoutingController({ claims, pacServer: server, proxyPort: () => port, pacPort: 8081, run, select: async s => s ?? 'Wi-Fi', record });
  t.after(() => controller.stop());
  const suspend = (reason, state) => pac.recordRoutingSuspension({ claims, reason, state, record });
  const rearm = (options = {}) => pac.rearmRouting({ claims, controller, run, record, ...options });
  return { claims, server, controller, calls, events, run, suspend, rearm, auto: () => auto, external: value => { auto = value; }, port: value => { port = value; } };
}

for (const reason of ['daemon_restart', 'daemon_shutdown', 'guardian_recovery']) {
  test(`${reason} retains both claims and re-arms routing`, async t => {
    const f = await fixture(t);
    await f.controller.set({ client_id: 'a', domains: ['a.test'], durationSeconds: 300 });
    await f.controller.set({ client_id: 'b', domains: ['b.test'], durationSeconds: 300 });
    const state = await readState();
    if (reason === 'daemon_restart') {
      await patchState({ pid: 2147483647 });
      await reconcileRuntime({ run: f.run, claims: f.claims, record: async (event, fields) => f.events.push({ event, ...fields }) });
    } else if (reason === 'guardian_recovery') {
      await patchState({ pid: 2147483647, runtime_role: 'daemon' });
      const tick = createGuardian({ read: readState, isAlive: () => false, acquire: async () => async () => {}, restore: opts => pac.clearPacRouting({ ...opts, run: f.run }), record: async () => {} });
      assert.equal((await tick()).action, 'dead_owner_recovered');
    } else {
      await pac.clearPacRouting({ run: f.run });
      await f.suspend(reason, state);
    }
    assert.equal((await f.claims.getSuspension()).reason, reason);
    await clearState();
    await f.rearm();
    assert.equal(f.auto().enabled, true);
    assert.equal(f.auto().url, 'http://127.0.0.1:8081/proxy.pac');
    assert.equal((await f.controller.status()).claims.filter(c => c.state === 'active').length, 2);
    assert.equal(await f.claims.getSuspension(), null);
    assert.equal(f.events.at(-1).event, 'routing_rearmed');
  });
}

test('external VPN changes are preserved, including changes before suspension', async t => {
  const f = await fixture(t);
  await f.controller.set({ client_id: 'a', domains: ['a.test'], durationSeconds: 300 });
  const state = await readState();
  f.external({ enabled: true, url: 'https://vpn.test/pac' });
  await pac.clearPacRouting({ run: f.run });
  await f.suspend('daemon_shutdown', state);
  const start = f.calls.length;
  await f.rearm();
  assert.deepEqual(f.auto(), { enabled: true, url: 'https://vpn.test/pac' });
  assert.ok(f.calls.slice(start).every(c => c[0].startsWith('-get')));
  assert.equal(f.events.at(-1).details.reason, 'external_change');
  assert.ok(await f.claims.getSuspension());
});

test('no claims clears suspension without networksetup calls', async t => {
  const f = await fixture(t);
  await f.suspend('daemon_restart', { network_service: 'Wi-Fi', pac_url: 'local' });
  await f.rearm();
  assert.equal(f.calls.length, 0);
  assert.equal(await f.claims.getSuspension(), null);
});

test('re-arm retries timeout failures with backoff and rereads external state', async t => {
  const f = await fixture(t);
  await f.claims.upsertClaim({ client_id: 'a', domains: ['a.test'], durationSeconds: 300 });
  await f.suspend('daemon_restart', { network_service: 'Wi-Fi', pac_url: 'local' });
  const waits = []; let attempts = 0;
  await f.rearm({ controller: { sync: async () => { if (++attempts < 3) throw Object.assign(new Error('timeout'), { code: 'ROUTING_COMMAND_TIMEOUT' }); return f.controller.sync(); } }, wait: async ms => waits.push(ms) });
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [20000, 40000]);
  assert.equal(f.events.filter(e => e.event === 'routing_not_rearmed').length, 2);
});

test('proxyPort function is evaluated on every sync', async t => {
  const f = await fixture(t);
  await f.controller.set({ client_id: 'a', domains: ['a.test'], durationSeconds: 300 });
  assert.match(f.server.body, /127\.0\.0\.1:8000/);
  f.port(9000); await f.controller.sync();
  assert.match(f.server.body, /127\.0\.0\.1:9000/);
});

test('expired metadata survives sweep and restart but is bounded and excluded from active claims', async t => {
  const f = await fixture(t);
  await f.claims.upsertClaim({ client_id: 'a', domains: ['a.test'], durationSeconds: 1, now: 1000 });
  assert.equal((await f.claims.sweepExpired({ now: 2000 })).expired.length, 1);
  assert.equal((await f.claims.sweepExpired({ now: 3000 })).expired.length, 0);
  const reopened = createRoutingClaimsStore({ now: () => 3000 });
  assert.equal((await reopened.listClaims()).length, 0);
  assert.equal((await reopened.listClaims({ includeExpired: true }))[0].expired, true);
  await reopened.sweepExpired({ now: 3602001 });
  assert.equal((await reopened.listClaims({ includeExpired: true })).length, 0);
});

test('retained metadata is capped at 256 and the union excludes expired rows', async t => {
  const f = await fixture(t);
  const rows = Array.from({ length: 300 }, (_, i) => ({ claim_id: `id${i}`, client_id: `c${i}`, task_id: null,
    domains: [`d${i}.test`], requested_seconds: 1, created_at: new Date(0).toISOString(), renewed_at: new Date(0).toISOString(), expires_at: new Date(1000 + i).toISOString() }));
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(`${STATE_DIR}/routing-claims.json`, JSON.stringify({ version: 1, claims: rows }));
  await f.claims.sweepExpired({ now: 2000 });
  const retained = await f.claims.listClaims({ includeExpired: true, now: 2000 });
  assert.equal(retained.length, 256);
  const { unionDomains } = await import('../src/lib/routing-claims.mjs');
  assert.deepEqual(unionDomains(retained), []);
});

test('suspension writes cannot lose concurrent claims from another store instance', async t => {
  const f = await fixture(t);
  const other = createRoutingClaimsStore();
  await Promise.all([
    f.claims.upsertClaim({ client_id: 'a', domains: ['a.test'], durationSeconds: 300 }),
    other.setSuspension({ reason: 'daemon_restart' }),
  ]);
  assert.equal((await f.claims.listClaims()).length, 1);
  assert.equal((await f.claims.getSuspension()).reason, 'daemon_restart');
});

test('failed re-arm stops after three retries and preserves suspension', async t => {
  const f = await fixture(t);
  await f.claims.upsertClaim({ client_id: 'a', domains: ['a.test'], durationSeconds: 300 });
  await f.suspend('daemon_restart', { network_service: 'Wi-Fi', pac_url: 'local' });
  let attempts = 0; const waits = [];
  await f.rearm({ controller: { sync: async () => { attempts++; throw Object.assign(new Error('timeout'), { code: 'ROUTING_COMMAND_TIMEOUT' }); } }, wait: async ms => waits.push(ms) });
  assert.equal(attempts, 4);
  assert.deepEqual(waits, [20000, 40000, 60000]);
  assert.ok(await f.claims.getSuspension());
});

test('VPN change during backoff stops re-arm retries', async t => {
  const f = await fixture(t);
  await f.claims.upsertClaim({ client_id: 'a', domains: ['a.test'], durationSeconds: 300 });
  await f.suspend('daemon_restart', { network_service: 'Wi-Fi', pac_url: 'local' });
  let attempts = 0;
  await f.rearm({ controller: { sync: async () => { attempts++; throw new Error('timeout'); } },
    wait: async () => f.external({ enabled: true, url: 'https://vpn.test/pac' }) });
  assert.equal(attempts, 1);
  assert.equal(f.events.at(-1).details.reason, 'external_change');
});
