import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveDestination, ReverseProxyManager } from '../src/lib/reverse-proxy.mjs';

test('reverse proxy preserves target base path and incoming query', () => {
  assert.equal(
    resolveDestination('https://api.example.test/v2', '/users?id=7').toString(),
    'https://api.example.test/v2/users?id=7',
  );
});

test('remote reverse-proxy binding requires explicit consent', async () => {
  const manager = new ReverseProxyManager();
  await assert.rejects(
    manager.create({ target_url: 'https://example.test', listen_host: '0.0.0.0' }),
    (error) => error.code === 'REMOTE_BIND_REQUIRES_CONSENT',
  );
  await assert.rejects(
    manager.create({ target_url: 'https://example.test', listen_host: '0.0.0.0', allow_remote: true }),
    (error) => error.code === 'REMOTE_ALLOWLIST_REQUIRED',
  );
});
