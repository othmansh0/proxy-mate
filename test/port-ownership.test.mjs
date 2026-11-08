import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ProxyEngine } from '../src/lib/proxy.mjs';
for (const host of ['127.0.0.1', '::1']) {
  test(`proxy startup refuses an occupied ${host} listener without claiming the other address family`, async (t) => {
    const occupied = net.createServer();
    try { await new Promise((resolve, reject) => { occupied.once('error', reject); occupied.listen(0, host, resolve); }); }
    catch (error) { if (error.code === 'EAFNOSUPPORT' || error.code === 'EADDRNOTAVAIL') return t.skip('IPv6 unavailable'); throw error; }
    t.after(() => new Promise((resolve) => occupied.close(resolve)));
    const engine = new ProxyEngine();t.after(() => engine.stop());
    await assert.rejects(engine.start({ port: occupied.address().port }), { code: 'PROXY_PORT_BUSY' });
    assert.equal(engine.port, null);assert.equal(engine.server, null);assert.equal(occupied.listening, true);
  });
}
