import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PROXY_MCP_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-app-gateway-'));
const { ProxyEngine } = await import('../src/lib/proxy.mjs');
const { AppProxyGateway } = await import('../src/lib/app-gateway.mjs');

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

function request(port, url) {
  return new Promise((resolve, reject) => {
    const outgoing = http.get({ host: '127.0.0.1', port, path: url,
      headers: { connection: 'close', 'proxy-authorization': 'must-not-reach-origin' } }, (response) => {
      const chunks = [];
      response.on('data', (data) => chunks.push(data));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    outgoing.on('error', reject);
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error('request timed out')));
  });
}

test('only positively identified app HTTP traffic enters capture storage', async (t) => {
  const origin = http.createServer((req, res) => {
    assert.equal(req.headers['proxy-authorization'], undefined);
    res.end('origin-response');
  });
  const originPort = await listen(origin);
  t.after(() => new Promise((resolve) => origin.close(resolve)));
  for (const identity of ['selected', 'other', 'unknown']) {
    const engine = new ProxyEngine({ sessionId: identity });
    await engine.start({ port: 0 });
    const gateway = new AppProxyGateway({ proxyPort: engine.port, classify: async () => identity });
    await gateway.start(0);
    try {
      const result = await request(gateway.port, `http://127.0.0.1:${originPort}/${identity}`);
      assert.equal(result.status, 200);
      assert.equal(result.body, 'origin-response');
      await Promise.all([...engine.captureWork.values()]);
      assert.equal(engine.flows.size, identity === 'selected' ? 1 : 0);
      assert.equal(gateway.status().connections[identity], 1);
    } finally {
      await gateway.stop();
      await engine.stop();
    }
  }
});

test('unselected and unattributed CONNECT streams remain opaque and bypass interception', async (t) => {
  const origin = net.createServer((socket) => socket.pipe(socket));
  const originPort = await listen(origin);
  t.after(() => new Promise((resolve) => origin.close(resolve)));
  const capture = net.createServer(() => assert.fail('Unselected TLS must never reach interception'));
  const capturePort = await listen(capture);
  t.after(() => new Promise((resolve) => capture.close(resolve)));
  for (const identity of ['other', 'unknown']) {
    const gateway = new AppProxyGateway({ proxyPort: capturePort, classify: async () => identity });
    await gateway.start(0);
    const socket = net.connect(gateway.port, '127.0.0.1');
    socket.on('error', () => {});
    await once(socket, 'connect');
    const connected = once(socket, 'data');
    socket.write(`CONNECT 127.0.0.1:${originPort} HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\n\r\n`);
    assert.match((await connected)[0].toString(), /200 Connection Established/);
    const opaque = Buffer.from([22, 3, 3, 0, 4, 0, 255, 128, 42]);
    const echoed = once(socket, 'data');
    socket.write(opaque);
    assert.deepEqual((await echoed)[0], opaque);
    socket.destroy();
    await gateway.stop();
  }
});

test('attribution failure passes HTTP through without capture', async (t) => {
  const origin = http.createServer((_req, res) => res.end('available'));
  const originPort = await listen(origin);
  t.after(() => new Promise((resolve) => origin.close(resolve)));
  const gateway = new AppProxyGateway({ proxyPort: 1, classify: async () => { throw new Error('Permission denied'); } });
  await gateway.start(0);
  t.after(() => gateway.stop());
  assert.equal((await request(gateway.port, `http://127.0.0.1:${originPort}/`)).body, 'available');
  assert.equal(gateway.status().connections.unknown, 1);
});
