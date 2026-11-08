import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmHostCertificateTrust, HOST_CERTIFICATE_DIALOG, HOST_CERTIFICATE_EXPLANATION } from '../src/lib/host-permission.mjs';
import { setupHostCertificate } from '../src/lib/host-cert.mjs';

test('native explanation passes text as data and requires an explicit Continue', async () => {
  await confirmHostCertificateTrust({ execute: async (file, args, options) => {
    assert.equal(file, '/usr/bin/osascript');
    assert.deepEqual(args, ['-e', HOST_CERTIFICATE_DIALOG, HOST_CERTIFICATE_EXPLANATION]);
    assert.equal(options.timeout, 125_000);
    assert.match(args[1], /default button "Cancel"/);
    assert.doesNotMatch(args[1], /default answer|with hidden answer|do shell script/);
    assert.match(args[2], /does not request access to saved Keychain passwords/);
    assert.match(args[2], /connected MCP clients/);
    return { stdout: 'Continue\n' };
  } });
});

test('cancel, timeout, and unexpected dialog responses never approve trust', async () => {
  for (const response of ['cancelled', '', 'OK', 'gave up:true']) {
    await assert.rejects(confirmHostCertificateTrust({ execute: async () => ({ stdout: response }) }), {
      code: 'HOST_CA_TRUST_CANCELLED',
    });
  }
});

test('an unavailable GUI returns actionable recovery without falling through to authentication', async () => {
  await assert.rejects(confirmHostCertificateTrust({ execute: async () => { throw new Error('No GUI session'); } }), (error) => {
    assert.equal(error.code, 'HOST_CA_EXPLANATION_UNAVAILABLE');
    assert.match(error.recovery, /interactive macOS login session/);
    return true;
  });
});

test('an already trusted certificate skips both dialogs and certificate installation', async () => {
  const result = await setupHostCertificate('/cert.pem', {
    getStatus: async () => ({ ok: true, installed: true, trusted: true }),
    confirm: async () => assert.fail('Unexpected explanation'),
    execute: async () => assert.fail('Unexpected certificate installation'),
  });
  assert.equal(result.status, 'already_trusted');
});

test('native explanation precedes certificate authentication and trust verification', async () => {
  const events = [];
  let inspections = 0;
  const result = await setupHostCertificate('/cert.pem', {
    getStatus: async () => {
      events.push('inspect');
      return ++inspections === 1
        ? { ok: true, installed: false, trusted: false }
        : { ok: true, installed: true, trusted: true };
    },
    confirm: async () => events.push('explain'),
    execute: async (file, args) => {
      events.push('authenticate');
      assert.equal(file, '/usr/bin/security');
      assert.equal(args[0], 'add-trusted-cert');
      assert.equal(args.at(-1), '/cert.pem');
    },
  });
  assert.deepEqual(events, ['inspect', 'explain', 'authenticate', 'inspect']);
  assert.equal(result.status, 'trusted');
});

test('cancelled or unavailable explanations prevent certificate installation', async () => {
  for (const code of ['HOST_CA_TRUST_CANCELLED', 'HOST_CA_EXPLANATION_UNAVAILABLE']) {
    const result = await setupHostCertificate('/cert.pem', {
      getStatus: async () => ({ ok: true, installed: false, trusted: false }),
      confirm: async () => { throw Object.assign(new Error('Not approved'), { code, recovery: 'Retry interactively.' }); },
      execute: async () => assert.fail('Certificate installation must not run'),
    });
    assert.equal(result.ok, false);
    assert.equal(result.trusted, false);
    assert.equal(result.code, code);
    assert.equal(result.recovery, 'Retry interactively.');
  }
});

test('macOS authentication failure remains a failure after the explanation', async () => {
  const result = await setupHostCertificate('/cert.pem', {
    getStatus: async () => ({ ok: true, installed: true, trusted: false }),
    confirm: async () => {},
    execute: async () => { throw new Error('Authorization denied'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'HOST_CA_TRUST_FAILED');
  assert.equal(result.installed, true);
});
