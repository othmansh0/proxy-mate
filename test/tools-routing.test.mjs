import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.PROXY_MATE_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-routing-'));
const { makeTools, INTERNAL_ROUTING_CONTROL } = await import('../src/lib/tools.mjs');
const { ProxyEngine } = await import('../src/lib/proxy.mjs');
const { PacServer, applyPacRouting } = await import('../src/lib/pac.mjs');
const { clearState, readState, patchState } = await import('../src/lib/state.mjs');
const { STATE_DIR } = await import('../src/lib/config.mjs');
const { recordRuntimeEvent } = await import('../src/lib/runtime-identity.mjs');
const a = { client_id: 'client-a', task_id: 'one' }, b = { client_id: 'client-b', task_id: 'two' };
async function fixture(t, mode = 'daemon') {
  await clearState();
  await fs.rm(path.join(STATE_DIR, 'routing-claims.json'), { force: true });
  for (const source of ['daemon', 'guardian']) {
    for (const suffix of ['.events.json', '.events.jsonl', '.events.jsonl.1']) {
      await fs.rm(path.join(STATE_DIR, `${source}${suffix}`), { force: true });
    }
  }
  let clock = Date.now(), actual = { enabled: false, url: '' }, fire;
  const run = async (_file, [cmd, _service, value]) => {
    if (cmd === '-getautoproxyurl') return { stdout: `URL: ${actual.url}\nEnabled: ${actual.enabled ? 'Yes' : 'No'}\n` };
    if (cmd === '-getwebproxy' || cmd === '-getsecurewebproxy') return { stdout: 'Enabled: No\n' };
    if (cmd === '-setautoproxyurl') actual.url = value;
    if (cmd === '-setautoproxystate') actual.enabled = value === 'on';
    return { stdout: '' };
  };
  const engine = new ProxyEngine(); engine.port = 8123; engine.isRunning = () => true;
  engine.caCertPath = '/fake/cert.pem';
  const pac = new PacServer();
  const tools = makeTools({ engine, pacServer: pac, mode, run, select: async () => 'Fake', pacPort: 0,
    now: () => clock, setTimer: fn => { fire = fn; return 1; }, clearTimer: () => {},
    hostCertificateStatus: async () => ({ trusted: true, ok: true }) });
  t.after(async () => { tools[INTERNAL_ROUTING_CONTROL].stop(); await pac.stop(); });
  return { tools, pac, run, engine, advance: async ms => { clock += ms; await fire(); }, external: () => { actual = { enabled: true, url: 'https://vpn.test/pac' }; } };
}
test('per-caller claims union, mine flags, task isolation and clear-all accounting', async t => {
  const { tools, pac } = await fixture(t);
  const first = await tools.set_proxy_routing({ domains: ['a.test'] }, a);
  assert.equal(first.claim.client_id, a.client_id);
  assert.equal(Date.parse(first.claim.expires_at) - Date.now() > 3590000, true);
  await tools.set_proxy_routing({ domains: ['b.test'] }, b);
  assert.match(pac.body, /a\.test/); assert.match(pac.body, /b\.test/);
  const status = await tools.get_proxy_status({}, a);
  assert.deepEqual(status.routing_claims.map(c => c.mine), [true, false]);
  await tools.clear_proxy_routing({}, a);
  assert.deepEqual((await tools.get_proxy_status({}, a)).routing_union, ['b.test']);
  assert.match(pac.body, /b\.test/); assert.doesNotMatch(pac.body, /a\.test/);
  await tools.set_proxy_routing({ domains: ['a.test'] }, a);
  const cleared = await tools.clear_proxy_routing({ scope: 'all' }, a);
  assert.equal(cleared.removed_other_claims.length, 1);
  assert.deepEqual(cleared.routing_union, []);
  assert.deepEqual((await tools.clear_proxy_routing({}, b)).routing_union, []);
});
test('SSL merge preserves exact expiry and merges only caller domains', async t => {
  const { tools } = await fixture(t);
  const first = await tools.set_proxy_routing({ domains: ['a.test'], duration_seconds: 10 }, a);
  await tools.set_proxy_routing({ domains: ['b.test'] }, b);
  const result = await tools.enable_ssl_proxying({ domain: 'new.test' }, a);
  assert.equal(result.routing.claim.expires_at, first.claim.expires_at);
  assert.deepEqual(result.routing.claim.domains, ['a.test', 'new.test']);
});
test('expiry warns only its owner on any tool and status explains loss', async t => {
  const { tools, advance } = await fixture(t);
  await tools.set_proxy_routing({ domains: ['a.test'], duration_seconds: 1 }, a);
  await tools.set_proxy_routing({ domains: ['b.test'], duration_seconds: 10 }, b);
  await advance(1001);
  const warning = (await tools.get_version({}, a)).routing_warning;
  assert.equal(warning.reason, 'lease_expired'); assert.equal(warning.state, 'expired');
  assert.equal((await tools.get_version({}, b)).routing_warning, undefined);
  const status = await tools.get_proxy_status({}, a);
  assert.equal(status.routing_lost_reason, 'lease_expired'); assert.ok(status.routing_lost_at);
  assert.equal(status.routing_claims.find(c => c.client_id === a.client_id).state, 'expired');
  await tools.set_proxy_routing({ domains: ['a.test'] }, a);
  assert.equal((await tools.get_version({}, a)).routing_warning, undefined);
});
test('external proxy conflicts preserve claims and report suspended routing', async t => {
  const { tools, external } = await fixture(t);
  await tools.set_proxy_routing({ domains: ['a.test'] }, a); external();
  await assert.rejects(tools.set_proxy_routing({ domains: ['b.test'] }, b), { code: 'ROUTING_CONFLICT' });
  await patchState({ routing_active: false });
  await recordRuntimeEvent('routing_not_rearmed', { reason: 'external_change' });
  assert.equal((await tools.get_proxy_status({}, a)).routing_lost_reason, 'external_change');
  assert.equal((await tools.get_version({}, a)).routing_warning.state, 'suspended');
});
test('legacy routing remains untouched until explicitly cleared', async t => {
  const { tools, pac, run } = await fixture(t);
  await applyPacRouting({ domains: ['legacy.test'], pacServer: pac, proxyPort: 8123, pacPort: 0, run, select: async () => 'Fake' });
  assert.deepEqual((await tools.get_proxy_status()).routing_claims, []);
  await tools.clear_proxy_routing({}, a);
  assert.equal((await readState()).routing_active, true);
  await tools.clear_proxy_routing({ scope: 'all' }, a);
  assert.equal((await readState()).routing_active, false);
});
test('clearing an expired claim acknowledges its warning; sibling tasks remain isolated', async t => {
  const { tools, advance } = await fixture(t);
  await tools.set_proxy_routing({ domains: ['a.test'], duration_seconds: 1 }, a);
  await tools.set_proxy_routing({ domains: ['sibling.test'], duration_seconds: 10 }, { ...a, task_id: 'sibling' });
  await advance(1001);
  assert.ok((await tools.get_version({}, a)).routing_warning);
  await tools.clear_proxy_routing({}, a);
  assert.equal((await tools.get_version({}, a)).routing_warning, undefined);
  assert.deepEqual((await tools.get_proxy_status({}, a)).routing_union, ['sibling.test']);
});
test('read-only status before startup does not bind routing to an obsolete port', async t => {
  const { tools, pac, engine } = await fixture(t);
  engine.port = null;
  await tools.get_proxy_status({}, a);
  // Start's engine binding may choose a fallback port after makeTools/status.
  assert.deepEqual((await tools.clear_proxy_routing({}, a)).routing_union, []);
  engine.port = 53210;
  await tools.set_proxy_routing({ domains: ['a.test'] }, a);
  assert.match(pac.body, /127\.0\.0\.1:53210/);
});
test('validation and initial conflicts leave no unintended claim', async t => {
  const { tools, external } = await fixture(t);
  await assert.rejects(tools.set_proxy_routing({ domains: ['*'] }, a), { code: 'BROAD_ROUTING_REQUIRES_CONSENT' });
  await assert.rejects(tools.set_proxy_routing({ domains: ['a.test'], duration_seconds: 0 }, a), { code: 'ROUTING_LEASE_INVALID' });
  external();
  await assert.rejects(tools.set_proxy_routing({ domains: ['a.test'] }, a), { code: 'ROUTING_CONFLICT' });
  assert.deepEqual((await tools.get_proxy_status({}, a)).routing_claims, []);
});
test('in-process callers serialize simultaneous independent claims and SSL merges', async t => {
  const { tools } = await fixture(t, 'in-process');
  await Promise.all([
    tools.set_proxy_routing({ domains: ['a.test'] }, a),
    tools.set_proxy_routing({ domains: ['b.test'] }, b),
  ]);
  await Promise.all([
    tools.enable_ssl_proxying({ domain: 'first.test' }, a),
    tools.enable_ssl_proxying({ domain: 'second.test' }, a),
  ]);
  assert.deepEqual((await tools.get_proxy_status({}, a)).routing_union, ['a.test', 'b.test', 'first.test', 'second.test']);
  await tools.clear_proxy_routing({}, a);
  assert.deepEqual((await tools.get_proxy_status({}, b)).routing_union, ['b.test']);
});
test('routing devices are validated before side effects and retained on the caller claim', async t => {
  const { tools } = await fixture(t);
  const udid = 'AAAAAAAA-1111-2222-3333-444444444444';
  await assert.rejects(tools.set_proxy_routing({ domains: ['a.test'], device_udid: 'invalid' }, a), { code: 'ROUTING_DEVICE_INVALID' });
  const { createRoutingClaimsStore } = await import('../src/lib/routing-claims.mjs');
  const claims = createRoutingClaimsStore();
  assert.equal((await claims.listClaims()).length, 0);
  for (const device_udid of [udid, [udid]]) {
    await tools.set_proxy_routing({ domains: ['a.test'], device_udid }, a);
    assert.deepEqual((await claims.listClaims()).find(c => c.client_id === a.client_id).device_udids, [udid]);
  }
});
