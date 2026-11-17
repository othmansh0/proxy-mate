import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { SessionStore } from '../src/lib/session-store.mjs';
import { ProxyEngine } from '../src/lib/proxy.mjs';

test('a real SQLite batch failure reaches proxy persistence health and diagnostics', async t => {
  const rootDir = await mkdtemp(join(tmpdir(), 'proxy-mate-batch-health-'));
  const store = new SessionStore({ rootDir });
  const engine = new ProxyEngine({ sessionStore: store, sessionId: 'batch-health' });
  const upstream = http.createServer((_req, res) => res.end('ok'));
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await engine.stop(); await store.close();
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    await rm(rootDir, { recursive: true, force: true });
  });
  await engine.start({ port: 0 });
  store.db.exec("CREATE TRIGGER fail_capture BEFORE INSERT ON flows BEGIN SELECT RAISE(ABORT, 'batch disk failure'); END");
  await new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port: engine.port, path: `http://127.0.0.1:${upstream.address().port}/` }, response => {
      response.resume(); response.on('end', resolve);
    });
    request.on('error', reject);
  });
  await Promise.all([...engine.flowPersistence.values()]);
  assert.equal(engine.persistenceHealth().ok, false);
  assert.match(engine.persistenceHealth().last_error.message, /batch disk failure/);
  assert.ok(engine.diagnostics.some(diagnostic => diagnostic.kind === 'session-store-error'));
  assert.equal((await store.getSession('batch-health')).flow_count, 0);
});
