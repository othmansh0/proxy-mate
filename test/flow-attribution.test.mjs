import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../src/lib/session-store.mjs';
import { createFlowAttributor } from '../src/lib/proxy.mjs';
import { createDeviceResolver, simulatorDeviceUdid } from '../src/lib/app-identity.mjs';
import { createRoutingClaimsStore } from '../src/lib/routing-claims.mjs';
import { MCP_TOOLS, successToolResult } from '../src/lib/mcp-contract.mjs';
const d1 = 'AAAAAAAA-1111-2222-3333-444444444444', d2 = 'BBBBBBBB-1111-2222-3333-444444444444';
const tick = () => new Promise(resolve => setImmediate(resolve));
const claim = (client, device, domains = ['api.test']) => ({ client_id: client, task_id: client, device_udids: [device], domains, expires_at: new Date(10000).toISOString() });
test('device wins on a shared host; unique hosts, ambiguous hosts, unknown and expiry', async () => {
  let now = 0, reads = 0;
  const rows = [claim('a', d1), claim('b', d2), claim('c', d2, ['other.*'])];
  const attribute = createFlowAttributor({ now: () => now, listClaims: async () => { reads++; return rows; } });
  attribute('api.test', d1); await tick();
  assert.equal(attribute('api.test', d1).owner_client, 'a');
  assert.equal(attribute('api.test', d1).attribution, 'device');
  assert.equal(attribute('api.test', null).attribution, 'ambiguous');
  assert.equal(attribute('other.test', null).owner_client, 'c');
  assert.equal(attribute('other.test', null).attribution, 'claim');
  assert.equal(attribute('none.test', null).attribution, 'unknown');
  assert.equal(reads, 1);
  now = 1000; attribute('api.test'); await tick(); assert.equal(reads, 2);
  now = 10000; assert.equal(attribute('api.test', d1).attribution, 'unknown');
});
test('failed claims refresh degrades to unknown, without throwing', async () => {
  const attribute = createFlowAttributor({ listClaims: async () => { throw new Error('unavailable'); } });
  attribute('api.test'); await tick(); assert.equal(attribute('api.test').attribution, 'unknown');
});
test('device lookup is nonblocking, batched, bounded and degrades visibly', async () => {
  let calls = 0;
  const resolve = createDeviceResolver({ maxPending: 2, execute: async file => {
    calls++; return { stdout: file.includes('lsof') ? 'p200\nn127.0.0.1:50000->127.0.0.1:8080\np200\nn127.0.0.1:50001->127.0.0.1:8080\n' : `/CoreSimulator/Devices/${d1}/data/App.app/App` };
  } });
  const sockets = new Map();
  const socket = port => { if (!sockets.has(port)) sockets.set(port, { remoteAddress: '127.0.0.1', remotePort: port, localPort: 8080 }); return sockets.get(port); };
  assert.equal(resolve(socket(50000)), null); resolve(socket(50001)); resolve(socket(50002));
  await tick(); assert.equal(resolve(socket(50000)), d1); assert.equal(calls, 2);
  assert.ok(resolve.status().degraded > 0);
  assert.equal(simulatorDeviceUdid('/CoreSimulator/Devices/not-a-uuid/data'), null);
  const failed = createDeviceResolver({ execute: async () => { throw Error('no permission'); } });
  failed(socket(50000)); await tick(); assert.equal(failed(socket(50000)), null); assert.ok(failed.status().degraded);
});
test('claims validate and persist up to eight device UUIDs', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wp19-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createRoutingClaimsStore({ directory });
  await store.upsertClaim({ client_id: 'a', domains: ['api.test'], durationSeconds: 100, device_udids: [d1] });
  assert.deepEqual((await store.listClaims())[0].device_udids, [d1]);
  for (const device_udids of [['bad'], Array(9).fill(d1)]) await assert.rejects(store.upsertClaim({ client_id: 'a', domains: ['api.test'], durationSeconds: 100, device_udids }));
});
test('owner and device filters include unknown only explicitly; attribution survives update/reopen', async t => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wp19-')); const store = new SessionStore({ rootDir }); t.after(async () => { await store.close(); await fs.rm(rootDir, { recursive: true, force: true }); });
  await store.createSession({ id: 's' });
  for (const flow of [{ id: 'a', owner_client: 'a', owner_task: 't', device_udid: d1, attribution: 'device' }, { id: 'b', owner_client: 'b', attribution: 'claim' }, { id: 'u' }]) await store.appendFlow({ sessionId: 's', flow });
  assert.deepEqual((await store.listFlows({ sessionId: 's', filters: { owner_client: 'a' } })).flows.map(f => f.id), ['a']);
  assert.deepEqual((await store.listFlows({ sessionId: 's', filters: { owner_client: 'a', include_unknown: true } })).flows.map(f => f.id), ['a', 'u']);
  assert.equal((await store.listFlows({ sessionId: 's', filters: { device_udid: d1, owner_task: 't' } })).flows.length, 1);
  assert.deepEqual((await store.listFlows({ sessionId: 's', filters: { owner_client: 'a', device_udid: d1, include_unknown: true } })).flows.map(f => f.id), ['a']);
  assert.equal(await store.getFlow({ sessionId: 's', flowId: 'a', filters: { owner_client: 'b' } }), null);
  await store.updateFlow({ sessionId: 's', flowId: 'a', patch: { response: { statusCode: 200 } } }); await store.close();
  assert.equal((await store.getFlow({ sessionId: 's', flowId: 'a' })).owner_client, 'a');
  assert.equal((await store.getFlow({ sessionId: 's', flowId: 'u' })).attribution, 'unknown');
});
test('contracts validate attribution and routing devices', () => {
  const input = MCP_TOOLS.find(t => t.name === 'set_proxy_routing').inputSchema;
  assert.equal(input.device_udid.safeParse([d1, d2]).success, true);
  assert.equal(input.device_udid.safeParse('bad').success, false);
  for (const name of ['get_flows', 'filter_flows', 'get_flow_detail']) {
    const def = MCP_TOOLS.find(t => t.name === name);
    const f = { id: 'a', owner_client: 'a', owner_task: null, device_udid: d1, attribution: 'device' };
    const result = successToolResult(name, {}, name === 'get_flow_detail' ? f : { flows: [f] }).structuredContent;
    assert.equal(def.outputSchema.safeParse(result).success, true);
    f.attribution = 'invalid';
    assert.equal(def.outputSchema.safeParse({ ...result, data: name === 'get_flow_detail' ? f : { flows: [f] } }).success, false);
  }
});
test('v2 database migrates forward idempotently without rewriting old JSON or counts', async t => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wp19-migrate-'));
  const store = new SessionStore({ rootDir });
  t.after(async () => { await store.close(); await fs.rm(rootDir, { recursive: true, force: true }); });
  await store.createSession({ id: 'old' });
  await store.appendFlow({ sessionId: 'old', flow: { id: 'legacy', request: { url: 'https://api.test' } } });
  const size = (await store.getSession('old')).total_bytes;
  // Reconstruct the pre-attribution v2 table, retaining its original JSON.
  store.db.exec(`DROP INDEX flows_owner_client; DROP INDEX flows_device_udid;
    ALTER TABLE flows DROP COLUMN owner_client; ALTER TABLE flows DROP COLUMN owner_task;
    ALTER TABLE flows DROP COLUMN device_udid; ALTER TABLE flows DROP COLUMN attribution;
    UPDATE store_meta SET value = '2' WHERE key = 'schema_version';`);
  await store.close();
  for (let n = 0; n < 2; n++) {
    const flow = await store.getFlow({ sessionId: 'old', flowId: 'legacy' });
    assert.equal(flow.attribution, 'unknown'); assert.equal(flow.owner_client, null);
    assert.equal((await store.getSession('old')).total_bytes, size);
    assert.equal((await store.storageStatus()).schema_version, 3);
    assert.ok(store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'flows_device_udid'").get());
    await store.close();
  }
});
