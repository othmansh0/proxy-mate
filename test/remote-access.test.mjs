import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRemoteAccessPolicy } from '../src/lib/proxy.mjs';

test('remote access requires an explicit bounded IP/CIDR allowlist', () => {
  assert.throws(
    () => buildRemoteAccessPolicy({ allowRemote: true }),
    (error) => error.code === 'REMOTE_ALLOWLIST_REQUIRED',
  );
  assert.throws(
    () => buildRemoteAccessPolicy({ allowRemote: true, allowedRemoteIps: ['192.168.1.0/99'] }),
    (error) => error.code === 'INVALID_REMOTE_ALLOWLIST_ENTRY',
  );
  assert.throws(
    () => buildRemoteAccessPolicy({ allowRemote: true, allowedRemoteIps: ['192.168.1.4'], remoteAccessTtlSeconds: 0 }),
    (error) => error.code === 'INVALID_REMOTE_ACCESS_TTL',
  );
});

test('remote access policy matches only configured IPv4 and IPv6 ranges', () => {
  const policy = buildRemoteAccessPolicy({
    allowRemote: true,
    allowedRemoteIps: ['192.168.20.0/24', '2001:db8::/48', '10.0.0.9'],
    remoteAccessTtlSeconds: 120,
  });
  assert.equal(policy.allowlist.check('192.168.20.44', 'ipv4'), true);
  assert.equal(policy.allowlist.check('192.168.21.44', 'ipv4'), false);
  assert.equal(policy.allowlist.check('10.0.0.9', 'ipv4'), true);
  assert.equal(policy.allowlist.check('10.0.0.10', 'ipv4'), false);
  assert.equal(policy.allowlist.check('2001:db8::123', 'ipv6'), true);
  assert.equal(policy.allowlist.check('2001:db9::123', 'ipv6'), false);
  assert.deepEqual(policy.entries, ['192.168.20.0/24', '2001:db8::/48', '10.0.0.9']);
  assert.ok(Date.parse(policy.expiresAt) > Date.now());
});
