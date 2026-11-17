import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { drainServer, trackServer, mockttpListener } from '../src/lib/drain.mjs';
import * as mockttp from 'mockttp';

async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }

test('drain finishes active HTTP, closes responses and refuses new connections', async () => {
  let finish;
  const server = http.createServer((_req, res) => { finish = () => res.end('done'); });
  const tracked = trackServer(server);
  const port = await listen(server);
  const received = new Promise((resolve, reject) => http.get({host:'127.0.0.1', port}, res => { res.resume(); res.on('end', () => resolve(res)); }).on('error', reject));
  await once(server, 'request');
  const stopping = drainServer(server, {graceMs: 1000, ...tracked});
  await assert.rejects(new Promise((resolve, reject) => net.connect(port, '127.0.0.1').on('connect', resolve).on('error', reject)), {code:'ECONNREFUSED'});
  finish();
  assert.equal((await received).statusCode, 200);
  assert.equal((await received).headers.connection, 'close');
  const result = await stopping;
  assert.equal(result.destroyed, 0); assert.equal(result.drained, 1);
  tracked.dispose();
});

for (const graceMs of [30, 0]) test(`CONNECT sockets are destroyed at drain deadline ${graceMs}`, async () => {
  const server = http.createServer();
  server.on('connect', (_req, socket) => socket.write('HTTP/1.1 200 OK\r\n\r\n'));
  const tracked = trackServer(server);
  const port = await listen(server);
  const socket = net.connect(port, '127.0.0.1');
  await once(socket, 'connect'); socket.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n'); await once(socket, 'data');
  const closed = once(socket, 'close');
  const result = await drainServer(server, {graceMs, ...tracked});
  await closed; assert.equal(result.destroyed, 1); tracked.dispose();
});

test('mockttp 4.6.x listener adapter is pinned and rejects changed internals', async () => {
  const require = createRequire(import.meta.url);
  assert.match(require(require.resolve('mockttp').replace(/dist\/main\.js$/, 'package.json')).version, /^4\.6\./, 'Re-audit the private mockttp listener adapter before upgrading');
  const mock = mockttp.getLocal(); await mock.start(0);
  try { const listener = mockttpListener(mock); assert.equal(listener, mock.server); assert.equal(typeof listener._httpServer.closeIdleConnections, 'function'); }
  finally { await mock.stop(); }
  assert.throws(() => mockttpListener({server:{}}), {code:'MOCKTTP_INTERNALS_CHANGED'});
});

test('upgraded sockets are destroyed even when HTTP closeAllConnections cannot close them', async () => {
  const server = http.createServer();
  server.on('upgrade', (_req,socket)=>socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n'));
  const tracked=trackServer(server); const port=await listen(server);
  const socket=net.connect(port,'127.0.0.1'); await once(socket,'connect');
  socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n'); await once(socket,'data');
  const closed=once(socket,'close'); const result=await drainServer(server,{graceMs:20,...tracked});
  await closed; assert.equal(result.destroyed,1); tracked.dispose();
});
