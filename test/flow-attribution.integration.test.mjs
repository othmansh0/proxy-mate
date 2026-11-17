import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.PROXY_MATE_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'wp19-capture-'));
const { ProxyEngine } = await import('../src/lib/proxy.mjs');
const { makeTools } = await import('../src/lib/tools.mjs');
const { PacServer } = await import('../src/lib/pac.mjs');
const d1 = 'AAAAAAAA-1111-2222-3333-444444444444', d2 = 'BBBBBBBB-1111-2222-3333-444444444444';
test('capture persists device ownership on shared host, exposes fields, and survives resolver failure', async t => {
  let device = d1;
  const claims = [d1, d2].map((d, i) => ({ client_id: `client-${i}`, task_id: `task-${i}`, device_udids: [d], domains: ['127.0.0.1'], expires_at: new Date(Date.now() + 60000).toISOString() }));
  const engine = new ProxyEngine({ deviceResolver: () => { if (device === 'fail') throw Error('lookup failed'); return device; }, routingClaims: { listClaims: async () => claims } });
  const upstream = http.createServer((req, res) => res.end('ok'));
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await engine.stop({ graceMs: 0 }); assert.equal(engine.captureSockets.size, 0); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  await engine.start({ port: 0 });
  for (const udid of [d1, d2, 'fail']) {
    device = udid;
    await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: engine.port, path: `http://127.0.0.1:${upstream.address().port}/${udid}` }, res => { res.resume(); res.on('end', resolve); }).on('error', reject));
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    if (engine.flows.size === 3 && [...engine.flows.values()].every(f => f.response)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await Promise.all(engine.captureWork.values());
  await Promise.all(engine.flowPersistence.values());
  const rows = (await engine.listDurableFlows()).flows;
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(f => f.owner_client), ['client-0', 'client-1', null]);
  assert.deepEqual(rows.map(f => f.attribution), ['device', 'device', 'unknown']);
  const tools = makeTools({ engine, pacServer: new PacServer() });
  assert.equal((await tools.get_flows({})).flows[0].attribution !== undefined, true);
  assert.equal((await tools.filter_flows({ conditions: [{ field: 'method', operator: 'equals', value: 'GET' }] })).flows.every(f => 'owner_client' in f), true);
  const detail = await tools.get_flow_detail({ flow_id: rows[0].id });
  assert.equal(detail.device_udid, d1);
  const exported = await engine.sessionStore.exportSession(engine.sessionId);
  assert.equal('owner_client' in exported.session.flows[0], false);
  assert.equal(JSON.stringify(exported).includes(d1), true); // URL remains intact; attribution identifiers are omitted.
  assert.equal('device_udid' in exported.session.flows[0], false);
});
