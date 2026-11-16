import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { confirmHostCertificateTrust } from './host-permission.mjs';

const execFileP = promisify(execFile);
const SECURITY = '/usr/bin/security';
const LOGIN_KEYCHAIN = path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db');

function options(timeout = 30_000) {
  return { timeout, maxBuffer: 2 * 1024 * 1024 };
}

export async function getHostCertificateStatus(certPath) {
  let cert;
  try { cert = new X509Certificate(await fs.readFile(certPath)); }
  catch (error) {
    return {
      ok: error.code === 'ENOENT', installed: false, trusted: false,
      code: error.code === 'ENOENT' ? 'CA_NOT_GENERATED' : 'INVALID_CA_CERTIFICATE',
      login_keychain: LOGIN_KEYCHAIN,
    };
  }
  const fingerprint = cert.fingerprint256.replaceAll(':', '').toUpperCase();
  let output = '';
  try {
    // Identify by SHA-256 fingerprint, not by common name: the CA's subject is
    // whatever the generator produced, and a name filter that drifts silently
    // reports an installed, trusted CA as absent — which also makes uninstall
    // leave a trusted root behind.
    const result = await execFileP(SECURITY, [
      'find-certificate', '-a', '-Z', LOGIN_KEYCHAIN,
    ], options());
    output = `${result.stdout}\n${result.stderr}`;
  } catch (error) {
    if (!/could not be found|item.*not.*found|SecKeychainSearchCopyNext/i.test(`${error?.stderr ?? ''}\n${error?.message ?? ''}`)) {
      return { ok: false, installed: false, trusted: false, code: 'KEYCHAIN_QUERY_FAILED', error: compactError(error), login_keychain: LOGIN_KEYCHAIN };
    }
  }
  const installed = output.replaceAll(':', '').toUpperCase().includes(fingerprint);
  let trusted = false;
  if (installed) {
    try {
      await execFileP(SECURITY, [
        'verify-cert', '-c', path.resolve(certPath), '-p', 'ssl', '-l', '-L', '-k', LOGIN_KEYCHAIN, '-q',
      ], options());
      trusted = true;
    } catch { /* present but trust settings may be absent */ }
  }
  return {
    ok: true,
    installed,
    trusted,
    fingerprint_sha256: fingerprint.toLowerCase(),
    login_keychain: LOGIN_KEYCHAIN,
  };
}

export async function setupHostCertificate(certPath, {
  getStatus = getHostCertificateStatus, confirm = confirmHostCertificateTrust, execute = execFileP,
} = {}) {
  const before = await getStatus(certPath);
  if (before.ok && before.installed && before.trusted) {
    return { ...before, status: 'already_trusted' };
  }
  try {
    await confirm();
    await execute(SECURITY, [
      'add-trusted-cert', '-r', 'trustRoot', '-p', 'ssl', '-k', LOGIN_KEYCHAIN, path.resolve(certPath),
    ], options(60_000));
  } catch (error) {
    return {
      ok: false,
      installed: before.installed ?? false,
      trusted: false,
      status: error.code === 'HOST_CA_TRUST_CANCELLED' ? 'cancelled' : 'failed',
      code: ['HOST_CA_TRUST_CANCELLED', 'HOST_CA_EXPLANATION_UNAVAILABLE'].includes(error.code)
        ? error.code : 'HOST_CA_TRUST_FAILED',
      error: compactError(error),
      recovery: error.recovery ?? 'Run `proxy-mate install` from an interactive macOS user session and approve Keychain access, or use --no-host-trust with narrowly scoped --domains.',
    };
  }
  const after = await getStatus(certPath);
  return {
    ...after,
    status: after.trusted ? 'trusted' : 'installed_unverified',
    recovery: after.trusted ? undefined : 'The certificate was added but trust could not be verified. Inspect it in Keychain Access before enabling broad routing.',
  };
}

export async function removeHostCertificate(certPath) {
  let cert;
  try { cert = new X509Certificate(await fs.readFile(certPath)); }
  catch { return { removed: false, reason: 'proxy CA file is absent or invalid' }; }
  const fingerprint = cert.fingerprint256.replaceAll(':', '').toUpperCase();
  const before = await getHostCertificateStatus(certPath);
  if (!before.installed) return { removed: false, reason: 'certificate is not installed', fingerprint_sha256: fingerprint.toLowerCase() };
  try {
    await execFileP(SECURITY, ['delete-certificate', '-Z', fingerprint, LOGIN_KEYCHAIN], options(60_000));
  } catch (error) {
    return { removed: false, code: 'HOST_CA_REMOVAL_FAILED', error: compactError(error), fingerprint_sha256: fingerprint.toLowerCase() };
  }
  const after = await getHostCertificateStatus(certPath);
  return { removed: !after.installed, fingerprint_sha256: fingerprint.toLowerCase(), status: after };
}

function compactError(error) {
  return `${error?.stderr || error?.message || error}`.trim().slice(0, 2000);
}
