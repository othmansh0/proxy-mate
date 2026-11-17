import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { ProxyEngine } from '../src/lib/proxy.mjs';
import { AppProxyGateway } from '../src/lib/app-gateway.mjs';
import { snapshotMetrics, resetMetrics } from '../src/lib/metrics.mjs';
import { validateCustomCaPaths } from '../src/lib/ca-paths.mjs';
import { limitedLog } from '../src/lib/drain.mjs';
import { STATE_DIR } from '../src/lib/config.mjs';

async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }
for (const gatewayMode of [false, true]) test(`slow upstream completes during ${gatewayMode ? 'gateway' : 'proxy'} drain`, async t => {
  let finish;
  const upstream = http.createServer((_req, res) => { finish = () => res.end('hello'); });
  const port = await listen(upstream);
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const engine = new ProxyEngine(); await engine.start({port:0});
  t.after(() => engine.stop({graceMs:0}));
  const gateway = gatewayMode ? new AppProxyGateway({proxyPort:engine.port, classify:async () => 'selected'}) : null;
  if (gateway) { await gateway.start(0); t.after(() => gateway.stop({graceMs:0})); }
  const pending = new Promise((resolve, reject) => http.get({host:'127.0.0.1', port:gateway?.port ?? engine.port, path:`http://127.0.0.1:${port}/secret?token=private`, headers:{connection:'close'}}, res => { res.resume(); res.on('end', () => resolve(res)); }).on('error', reject));
  await once(upstream, 'request');
  const stopping = (gateway ?? engine).stop({graceMs:1000});
  // Wait for the listener to close, without delaying the active response to deadline.
  await new Promise(resolve => setImmediate(resolve));
  finish(); assert.equal((await pending).statusCode, 200); assert.equal((await pending).headers.connection, 'close'); await stopping;
  assert.ok(snapshotMetrics().counters['proxy.flows_completed'] >= 1);
  assert.ok(snapshotMetrics().counters['proxy.bytes'] >= 5);
});

test('proxy abort logs include safe context and counters', async t => {
  const engine = new ProxyEngine({logWrite: line => lines.push(line)});
  const lines = []; await engine.start({port:0}); t.after(() => engine.stop({graceMs:0}));
  engine.server.eventEmitter.emit('rule-event', {requestId:'flow-safe', eventType:'passthrough-request-head', eventData:{method:'POST',hostname:'example.com',port:443,path:'/secret?token=private',rawHeaders:['Authorization','SECRET']}});
  engine.server.eventEmitter.emit('rule-event', {requestId:'flow-safe', eventType:'passthrough-abort', eventData:{error:{code:'ECONNRESET'},downstreamAborted:true}});
  assert.match(lines.join(''), /flow_id=flow-safe.*method=POST.*host=example.com.*port=443/);
  assert.doesNotMatch(lines.join(''), /secret|private|Authorization|SECRET/);
  assert.ok(snapshotMetrics().counters['proxy.requests_aborted'] >= 1);
});

for (const mode of ['proxy','gateway']) test(`${mode} connection drops are counted`, async t => {
  resetMetrics();
  const service = mode === 'proxy' ? new ProxyEngine() : new AppProxyGateway({proxyPort:1, classify:async ()=>'other'});
  await service.start(mode === 'proxy' ? {port:0} : 0); t.after(()=>service.stop({graceMs:0}));
  const server = mode === 'proxy' ? service.server.server : service.server;
  server.maxConnections = 1;
  const first = net.connect(service.port, '127.0.0.1'); t.after(()=>first.destroy()); await once(first,'connect');
  const dropped = once(server,'drop');
  const second = net.connect(service.port, '127.0.0.1'); second.on('error',()=>{}); t.after(()=>second.destroy());
  await dropped;
  assert.equal(snapshotMetrics().counters[`${mode}.connections_dropped`],1);
});

test('custom CA missing and directory errors propagate with recovery', async () => {
  for (const file of [`${STATE_DIR}/missing`, STATE_DIR]) {
    const engine = new ProxyEngine();
    await assert.rejects(engine.start({port:0,caKeyPath:file,caCertPath:file}), error => error.code === 'CUSTOM_CA_UNREADABLE' && error.details.key_path === file && error.recovery.length > 0);
  }
  await assert.rejects(validateCustomCaPaths({keyPath:'key',certPath:'cert',stat:async()=>{throw Object.assign(new Error(),{code:'EPERM'});}}), error=>error.code==='CUSTOM_CA_UNREADABLE' && error.details.key_problem==='permission_denied');
});

test('abort rate limiter emits twenty lines and a single suppression summary', () => {
  const lines=[]; let clock=0;
  const log=limitedLog('proxy','request aborted',{write:line=>lines.push(line),now:()=>clock});
  for(let n=0;n<25;n++) log({flow_id:n});
  assert.equal(lines.length,20); clock=10000; log.flush();
  assert.equal(lines.length,21); assert.match(lines[20],/suppressed_count=5/);
});

for (const graceMs of [40, 0]) test(`proxy stop closes opaque CONNECT at grace ${graceMs}`, async t => {
  const engine = new ProxyEngine(); await engine.start({port:0}); t.after(()=>engine.stop({graceMs:0}));
  const socket = net.connect(engine.port,'127.0.0.1'); socket.on('error',()=>{}); t.after(()=>socket.destroy());
  await once(socket,'connect'); socket.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n'); await once(socket,'data');
  const closed = once(socket,'close'); await engine.stop({graceMs}); await closed;
});

test('request context stays bounded and capture omissions increment metrics', async t => {
  const engine = new ProxyEngine(); await engine.start({port:0}); t.after(()=>engine.stop({graceMs:0}));
  for(let n=0;n<2100;n++) engine.server.eventEmitter.emit('rule-event',{requestId:`bounded-${n}`,eventType:'passthrough-request-head',eventData:{method:'GET',hostname:'example.com',port:80}});
  assert.equal(engine.requestContexts.size,2048); assert.equal(engine.requestContexts.has('bounded-0'),false);
  const before = snapshotMetrics().counters['proxy.capture_dropped'] ?? 0;
  for(let n=0;n<101;n++) engine.server.eventEmitter.emit('request',{id:`capture-${n}`,body:{buffer:Buffer.alloc(0)}});
  assert.equal(snapshotMetrics().counters['proxy.capture_dropped'],before+1);
});

test('permission CA error propagates unchanged through engine startup', async () => {
  const stat = async () => { throw Object.assign(new Error('denied'), {code:'EACCES'}); };
  let expected;
  try { await validateCustomCaPaths({keyPath:'/test-key',certPath:'/test-cert',stat}); } catch (error) { expected=error; }
  const engine = new ProxyEngine({caStat:stat});
  await assert.rejects(engine.start({port:0,caKeyPath:'/test-key',caCertPath:'/test-cert'}), error => {
    assert.equal(error.code, expected.code); assert.deepEqual(error.details,expected.details); assert.deepEqual(error.recovery,expected.recovery); return true;
  });
});

test('active connection gauge includes multiple engines and survives one stopping', async t => {
  const first = new ProxyEngine(); const second = new ProxyEngine();
  await first.start({port:0}); await second.start({port:0});
  t.after(()=>first.stop({graceMs:0})); t.after(()=>second.stop({graceMs:0}));
  const accepted = [once(first.server.server,'connection'),once(second.server.server,'connection')];
  const a=net.connect(first.port,'127.0.0.1'); const b=net.connect(second.port,'127.0.0.1');
  t.after(()=>a.destroy()); t.after(()=>b.destroy());
  await Promise.all([...accepted,once(a,'connect'),once(b,'connect')]);
  assert.equal(snapshotMetrics().gauges['proxy.active_connections'],2);
  await first.stop({graceMs:0}); assert.equal(snapshotMetrics().gauges['proxy.active_connections'],1);
});
