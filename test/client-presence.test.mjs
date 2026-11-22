import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.PROXYFAN_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'presence-test-'));
const { createClientRegistry } = await import('../src/lib/client-registry.mjs');
const { makeTools, INTERNAL_ROUTING_CONTROL, INTERNAL_PRESENCE_LOST } = await import('../src/lib/tools.mjs');
const { ControlServer, callDaemon } = await import('../src/lib/control.mjs');
const { ProxyEngine } = await import('../src/lib/proxy.mjs');
const { PacServer } = await import('../src/lib/pac.mjs');
const { clearState, readHandshake } = await import('../src/lib/state.mjs');
const { readRuntimeEvents } = await import('../src/lib/runtime-identity.mjs');
const { MCP_TOOLS, successToolResult } = await import('../src/lib/mcp-contract.mjs');
const a = { client_id: 'client-a', task_id: 'one' }, b = { client_id: 'client-b', task_id: 'private' };

test('heartbeat renews one owner without network churn; absence clears all its tasks and preserves peers', async t => {
  await clearState();
  let now = Date.now(), calls = 0, selections = 0, actual = { enabled: false, url: '' };
  const run = async (_file, [cmd, _service, value]) => {
    calls++;
    if (cmd === '-getautoproxyurl') return { stdout: `URL: ${actual.url}\nEnabled: ${actual.enabled ? 'Yes' : 'No'}\n` };
    if (cmd === '-getwebproxy' || cmd === '-getsecurewebproxy') return { stdout: 'Enabled: No\n' };
    if (cmd === '-setautoproxyurl') actual.url = value;
    if (cmd === '-setautoproxystate') actual.enabled = value === 'on';
    return { stdout: '' };
  };
  let tools;
  const registry = createClientRegistry({ now: () => now, startupGraceMs: 0,
    onPresenceLost: c => tools[INTERNAL_PRESENCE_LOST](c) });
  const engine = new ProxyEngine(); engine.port = 8123; engine.isRunning = () => true;
  const pac = new PacServer();
  tools = makeTools({ engine, pacServer: pac, clientRegistry: registry, mode: 'daemon', run,
    select: async () => { selections++; return 'Fake'; }, pacPort: 0, now: () => now,
    setTimer: () => ({ unref() {} }), clearTimer: () => {}, hostCertificateStatus: async () => ({ trusted: true }) });
  const ctrl = new ControlServer({ port: 0, tools, clientRegistry: registry,
    onHeartbeat: id => tools[INTERNAL_ROUTING_CONTROL].renew(id, { sync: false }) });
  await ctrl.start();
  t.after(async () => { await ctrl.stop(); tools[INTERNAL_ROUTING_CONTROL].stop(); await pac.stop(); });
  const hs = await readHandshake();
  for (const [who, domain] of [[a, 'a.test'], [{ ...a, task_id: 'another' }, 'a2.test'], [b, 'b.test']]) {
    await tools.set_proxy_routing({ domains: [domain], duration_seconds: 600 }, who);
    registry.touch(who);
  }
  const before = await tools[INTERNAL_ROUTING_CONTROL].status();
  now += 30000;
  const count = calls, selected = selections;
  const response = await fetch(`${hs.controlUrl}/heartbeat`, { method: 'POST',
    headers: { authorization: `Bearer ${hs.token}`, 'x-proxyfan-client-id': a.client_id }, body: JSON.stringify(a) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).interval_ms, 30000);
  assert.equal(calls, count); assert.equal(selections, selected);
  const after = await tools[INTERNAL_ROUTING_CONTROL].status();
  assert.ok(Date.parse(after.claims[0].expires_at) > Date.parse(before.claims[0].expires_at));
  assert.equal(after.claims[2].expires_at, before.claims[2].expires_at);
  await callDaemon({ ...hs, client: b, tool: 'get_proxy_status' });
  const status = await tools.get_proxy_status({}, a);
  assert.deepEqual(status.clients, { count: 2, alive: 2, me: { ...a, last_seen: now } });
  const schema = MCP_TOOLS.find(t => t.name === 'get_proxy_status').outputSchema;
  assert.equal(schema.safeParse(successToolResult('get_proxy_status', {}, status).structuredContent).success, true);
  assert.equal(schema.safeParse(successToolResult('get_proxy_status', {}, { ...status, clients: { count: 'bad' } }).structuredContent).success, false);
  now += 90001; registry.touch(b); await registry.sweep();
  assert.deepEqual((await tools[INTERNAL_ROUTING_CONTROL].status()).union_domains, ['b.test']);
  assert.equal(actual.enabled, true);
  const event = (await readRuntimeEvents()).find(e => e.event === 'client_presence_lost');
  assert.equal(event.claims_removed, 2);
});

test('heartbeats require auth, bound bodies, bypass general slots, and consume per-client rate', async t => {
  const registry = createClientRegistry();
  let renewals = 0;
  const ctrl = new ControlServer({ port: 0, tools: {}, clientRegistry: registry, rateLimit: 2,
    onHeartbeat: () => { renewals++; } });
  await ctrl.start(); t.after(() => ctrl.stop());
  const hs = await readHandshake();
  ctrl.activeRequests = ctrl.maxConcurrentRequests;
  const post = (body, token = hs.token, id = a.client_id) => fetch(`${hs.controlUrl}/heartbeat`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-proxyfan-client-id': id }, body: JSON.stringify(body) });
  assert.equal((await post(a, 'wrong')).status, 401);
  assert.equal((await post({ client: a })).status, 200);
  assert.equal((await post(a)).status, 200);
  assert.equal((await post(a)).status, 429);
  assert.equal((await post(b, hs.token, b.client_id)).status, 200);
  assert.equal(renewals, 3);
  assert.equal(ctrl.activeRequests, ctrl.maxConcurrentRequests);
  assert.equal((await post({ ...b, client_id: 'invalid' }, hs.token, 'client-c')).status, 400);
  const large = await post({ ...a, padding: 'x'.repeat(5000) }, hs.token, 'client-d');
  assert.equal(large.status, 413);
});
