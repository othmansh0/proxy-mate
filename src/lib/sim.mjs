// Production-safe Xcode Simulator certificate automation. All commands are
// spawned without a shell, never with sudo, and use a per-process
// DEVELOPER_DIR so proxy-mcp does not modify the user's global Xcode selection.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import os from 'node:os';
import { STATE_DIR } from './config.mjs';
import { atomicWriteFile } from './state.mjs';

const execFileP = promisify(execFile);
const COMMAND_TIMEOUT_MS = 30_000;
const BOOT_TIMEOUT_MS = 180_000;

function commandOptions(developerDir, timeout = COMMAND_TIMEOUT_MS) {
  return {
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    env: developerDir ? { ...process.env, DEVELOPER_DIR: developerDir } : process.env,
  };
}

async function run(file, args, { developerDir, timeout } = {}) {
  return execFileP(file, args, commandOptions(developerDir, timeout));
}

function simctlArgs(deviceSet, ...args) {
  return ['simctl', ...(deviceSet ? ['--set', path.resolve(deviceSet)] : []), ...args];
}

export async function simulatorPreflight({ developer_dir } = {}) {
  const candidates = await xcodeCandidates(developer_dir);
  const attempted = [];
  for (const candidate of candidates) {
    try {
      const [{ stdout: simctlPath }, { stdout: version }] = await Promise.all([
        run('/usr/bin/xcrun', ['--find', 'simctl'], { developerDir: candidate }),
        run('/usr/bin/xcodebuild', ['-version'], { developerDir: candidate }),
      ]);
      const { stdout: keychainHelp, stderr = '' } = await run(
        '/usr/bin/xcrun', ['simctl', 'help', 'keychain'], { developerDir: candidate },
      );
      const help = `${keychainHelp}\n${stderr}`;
      if (!help.includes('add-root-cert')) {
        return failurePreflight('SIMCTL_KEYCHAIN_UNSUPPORTED',
          'This Xcode does not support simctl keychain add-root-cert. Xcode 11.4 or newer is required.',
          { developer_dir: candidate, xcode_version: version.trim() });
      }
      return {
        ok: true,
        developer_dir: candidate,
        xcode_version: version.trim(),
        simctl_path: simctlPath.trim(),
        capabilities: {
          add_root_cert: true,
          add_cert: /\badd-cert\b/.test(help),
          reset_keychain: /\breset\b/.test(help),
        },
      };
    } catch (error) {
      attempted.push({ developer_dir: candidate, error: compactError(error) });
    }
  }

  let selected = null;
  try { selected = (await run('/usr/bin/xcode-select', ['-p'])).stdout.trim(); } catch { /* absent */ }
  const commandLineToolsOnly = selected === '/Library/Developer/CommandLineTools';
  return failurePreflight(
    commandLineToolsOnly ? 'FULL_XCODE_REQUIRED' : 'XCODE_NOT_FOUND',
    commandLineToolsOnly
      ? 'simctl is included with full Xcode, not the standalone Command Line Tools. Install/open Xcode once, then select its Command Line Tools in Xcode Settings > Locations.'
      : 'A usable full Xcode installation with simctl was not found. Install/open Xcode once or pass developer_dir.',
    { selected_developer_dir: selected, attempted },
  );
}

function failurePreflight(code, message, extra = {}) {
  return { ok: false, code, message, recovery: message, ...extra };
}

async function xcodeCandidates(explicit) {
  const values = [];
  if (explicit) values.push(path.resolve(explicit));
  if (process.env.DEVELOPER_DIR) values.push(path.resolve(process.env.DEVELOPER_DIR));
  try { values.push((await run('/usr/bin/xcode-select', ['-p'])).stdout.trim()); } catch { /* absent */ }
  values.push('/Applications/Xcode.app/Contents/Developer');
  try {
    for (const name of await fs.readdir('/Applications')) {
      if (/^Xcode.*\.app$/i.test(name)) values.push(path.join('/Applications', name, 'Contents', 'Developer'));
    }
  } catch { /* inaccessible */ }
  return [...new Set(values.filter((v) => v && v.includes('.app/Contents/Developer')))];
}

export async function listSimulators({ scope = 'booted', device_ids, developer_dir, device_set } = {}) {
  const preflight = await simulatorPreflight({ developer_dir });
  if (!preflight.ok) return { preflight, simulators: [] };
  let stdout;
  try {
    ({ stdout } = await run(
      '/usr/bin/xcrun', simctlArgs(device_set, 'list', 'devices', 'available', '--json'),
      { developerDir: preflight.developer_dir },
    ));
  } catch {
    ({ stdout } = await run(
      '/usr/bin/xcrun', simctlArgs(device_set, 'list', 'devices', 'available', '-j'),
      { developerDir: preflight.developer_dir },
    ));
  }
  const data = JSON.parse(stdout);
  const wanted = new Set(device_ids ?? []);
  const simulators = [];
  for (const [runtime, devices] of Object.entries(data.devices || {})) {
    for (const device of devices) {
      if (!device?.isAvailable || !device?.udid) continue;
      if (scope === 'booted' && device.state !== 'Booted') continue;
      if (wanted.size && !wanted.has(device.udid)) continue;
      simulators.push({
        udid: device.udid,
        name: device.name,
        state: device.state,
        runtime,
        data_path: device.dataPath ?? null,
      });
    }
  }
  return { preflight, simulators, device_set: device_set ? path.resolve(device_set) : null };
}

export async function discoverXcodePreviewDeviceSets({ preview_device_set } = {}) {
  const candidates = [
    preview_device_set,
    process.env.PROXY_MCP_PREVIEW_DEVICE_SET,
    path.join(os.homedir(), 'Library', 'Developer', 'Xcode', 'UserData', 'Previews', 'Simulator Devices'),
  ].filter(Boolean).map((value) => path.resolve(value));
  const available = [];
  for (const candidate of [...new Set(candidates)]) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) available.push(candidate);
    } catch { /* feature is absent in this Xcode installation */ }
  }
  return {
    device_sets: available,
    supported: available.length > 0,
    stability: 'feature_detected_private_layout',
    note: 'Xcode Preview device-set locations are not a stable public Apple API and are used only after filesystem feature detection.',
  };
}

export async function listBootedSimulators(options = {}) {
  const result = await listSimulators({ ...options, scope: 'booted' });
  return result.simulators;
}

export async function inspectCertificate(certPath, { stage_der = true } = {}) {
  let pemOrDer;
  try { pemOrDer = await fs.readFile(certPath); }
  catch (error) {
    if (error.code === 'ENOENT') return { ok: false, code: 'CA_NOT_GENERATED', message: 'The proxy CA has not been generated yet.' };
    return { ok: false, code: 'CA_READ_FAILED', message: `Unable to read CA certificate: ${error.message}` };
  }
  let cert;
  try { cert = new X509Certificate(pemOrDer); }
  catch (error) {
    return { ok: false, code: 'INVALID_CA_CERTIFICATE', message: `Unable to parse CA certificate: ${error.message}` };
  }
  const now = Date.now();
  const validFrom = Date.parse(cert.validFrom);
  const validTo = Date.parse(cert.validTo);
  if (!cert.ca) return { ok: false, code: 'CERTIFICATE_IS_NOT_CA', message: 'The configured certificate is not an X.509 CA certificate.' };
  if (!(validFrom <= now && now < validTo)) {
    return { ok: false, code: 'CERTIFICATE_NOT_CURRENTLY_VALID', message: `CA validity is ${cert.validFrom} through ${cert.validTo}.` };
  }
  const keyType = cert.publicKey.asymmetricKeyType;
  const keyDetails = cert.publicKey.asymmetricKeyDetails ?? {};
  if (keyType === 'rsa' && (keyDetails.modulusLength ?? 0) < 2048) {
    return { ok: false, code: 'CA_KEY_TOO_SMALL', message: 'Apple TLS requires an RSA CA key of at least 2048 bits.' };
  }
  // Custom CAs may live in read-only directories. Never overwrite a sibling
  // cert.der belonging to another certificate or the original DER input.
  const fingerprint = cert.fingerprint256.replaceAll(':', '').toLowerCase();
  const derPath = path.join(STATE_DIR, 'ca', 'public', `${fingerprint}.der`);
  if (stage_der) await atomicWriteFile(derPath, cert.raw, 0o644);
  return {
    ok: true,
    subject: cert.subject,
    issuer: cert.issuer,
    fingerprint_sha256: cert.fingerprint256.replaceAll(':', '').toLowerCase(),
    valid_from: cert.validFrom,
    valid_to: cert.validTo,
    public_key: { type: keyType, ...jsonSafeKeyDetails(keyDetails) },
    der_path: stage_der ? derPath : null,
  };
}

// Node reports RSA publicExponent as a BigInt, which JSON.stringify refuses to
// serialize. This result crosses the control plane and the MCP wire, so a raw
// spread makes every certificate tool fail on an ordinary RSA CA.
function jsonSafeKeyDetails(details) {
  const safe = {};
  for (const [key, value] of Object.entries(details)) {
    if (typeof value !== 'bigint') { safe[key] = value; continue; }
    safe[key] = value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  }
  return safe;
}

export async function trustCaOnSimulator(udid, certPath, { developer_dir, device_set } = {}) {
  await run('/usr/bin/xcrun', simctlArgs(device_set, 'keychain', udid, 'add-root-cert', path.resolve(certPath)), {
    developerDir: developer_dir,
  });
}

export async function setupSimulatorCertificates({
  cert_path,
  scope = 'booted',
  device_ids,
  developer_dir,
  boot_shutdown = false,
  restart_apps = false,
  bundle_id,
  device_set,
} = {}) {
  const certificate = await inspectCertificate(cert_path);
  if (!certificate.ok) return { ok: false, certificate, results: [] };
  const listed = await listSimulators({ scope, device_ids, developer_dir, device_set });
  if (!listed.preflight.ok) return { ok: false, certificate, preflight: listed.preflight, results: [] };
  if (listed.simulators.length === 0) {
    return {
      ok: true, certificate, preflight: listed.preflight, results: [],
      skipped: scope === 'booted' ? 'No booted simulators found.' : 'No matching available simulators found.',
    };
  }

  const results = [];
  for (const sim of listed.simulators) {
    const initiallyBooted = sim.state === 'Booted';
    if (!initiallyBooted && !boot_shutdown) {
      results.push({ ...sim, status: 'skipped_shutdown', recovery: 'Pass boot_shutdown=true to temporarily boot this simulator.' });
      continue;
    }
    try {
      if (!initiallyBooted) {
        await run('/usr/bin/xcrun', simctlArgs(device_set, 'bootstatus', sim.udid, '-b'), {
          developerDir: listed.preflight.developer_dir, timeout: BOOT_TIMEOUT_MS,
        });
      }
      await trustCaOnSimulator(sim.udid, certificate.der_path, {
        developer_dir: listed.preflight.developer_dir, device_set,
      });
      let restart = null;
      if (restart_apps) restart = await restartSimApps({ udid: sim.udid, bundle_id, developer_dir: listed.preflight.developer_dir, device_set });
      results.push({
        ...sim,
        status: 'trusted_root_imported',
        certificate_imported: true,
        system_tls_verified: false,
        manual_trust_may_be_required: false,
        verification_note: 'simctl imported the CA into the trusted root store. Run verify_simulator_certificate to verify native URLSession TLS trust.',
        recovery: 'If HTTPS still fails, run verify_simulator_certificate, then check routing and app-specific certificate pinning.',
        restart,
      });
    } catch (error) {
      if (isDuplicateCertificateError(error)) {
        results.push({
          ...sim,
          status: 'already_present_unverified',
          certificate_imported: true,
          system_tls_verified: false,
          manual_trust_may_be_required: true,
          recovery: 'The CA already exists. If HTTPS still fails, enable proxy-mcp CA under Simulator Settings > General > About > Certificate Trust Settings.',
        });
      } else {
        results.push({ ...sim, status: 'failed', error: classifySimctlError(error) });
      }
    } finally {
      if (!initiallyBooted && boot_shutdown) {
        try {
          await run('/usr/bin/xcrun', simctlArgs(device_set, 'shutdown', sim.udid), { developerDir: listed.preflight.developer_dir });
        } catch { /* preserve the primary outcome */ }
      }
    }
  }
  return {
    ok: results.every((r) => r.status !== 'failed'),
    certificate,
    preflight: listed.preflight,
    results,
    device_set: device_set ? path.resolve(device_set) : null,
  };
}

export async function setupXcodePreviewCertificate(options = {}) {
  const discovery = await discoverXcodePreviewDeviceSets(options);
  if (!discovery.supported) {
    return {
      ok: false,
      code: 'XCODE_PREVIEW_DEVICE_SET_NOT_FOUND',
      discovery,
      recovery: 'Open a SwiftUI Preview at least once, then retry or pass preview_device_set explicitly.',
      results: [],
    };
  }
  const reports = [];
  for (const deviceSet of discovery.device_sets) {
    reports.push(await setupSimulatorCertificates({
      ...options,
      scope: options.scope ?? 'booted',
      device_set: deviceSet,
    }));
  }
  return {
    ok: reports.every((report) => report.ok),
    discovery,
    reports,
    results: reports.flatMap((report) => report.results ?? []),
  };
}

export async function trustCaOnSimulators(certPath, options = {}) {
  const report = await setupSimulatorCertificates({ cert_path: certPath, scope: 'booted', ...options });
  const trusted = report.results?.filter((r) => ['trusted_root_imported', 'already_present_unverified'].includes(r.status)) ?? [];
  const failed = report.results?.filter((r) => r.status === 'failed') ?? [];
  return { ...report, trusted, failed };
}

export async function listRunningAppsOnSimulator(udid, { developer_dir, device_set } = {}) {
  try {
    const { stdout } = await run('/usr/bin/xcrun', simctlArgs(device_set, 'spawn', udid, 'launchctl', 'list'), { developerDir: developer_dir });
    const apps = new Set();
    for (const line of stdout.split('\n')) {
      const match = line.match(/UIKitApplication:([^\[\s]+)/);
      if (match) apps.add(match[1]);
    }
    return [...apps];
  } catch { return []; }
}

export async function restartAppOnSimulator(udid, bundleId, { developer_dir, device_set } = {}) {
  try { await run('/usr/bin/xcrun', simctlArgs(device_set, 'terminate', udid, bundleId), { developerDir: developer_dir }); }
  catch { /* not running is fine */ }
  await run('/usr/bin/xcrun', simctlArgs(device_set, 'launch', udid, bundleId), { developerDir: developer_dir });
}

export async function restartSimApps({ udid, bundle_id, developer_dir, device_set } = {}) {
  const listed = await listSimulators({ scope: 'booted', device_ids: udid ? [udid] : undefined, developer_dir, device_set });
  if (!listed.preflight.ok) return { restarted: [], failed: [], preflight: listed.preflight };
  if (listed.simulators.length === 0) return { restarted: [], failed: [], skipped: 'no booted simulators' };
  const restarted = [], failed = [];
  for (const sim of listed.simulators) {
    const bundles = bundle_id ? [bundle_id] : await listRunningAppsOnSimulator(sim.udid, { developer_dir: listed.preflight.developer_dir, device_set });
    const ok = [], errors = [];
    for (const bundle of bundles) {
      try { await restartAppOnSimulator(sim.udid, bundle, { developer_dir: listed.preflight.developer_dir, device_set }); ok.push(bundle); }
      catch (error) { errors.push({ bundle, error: compactError(error) }); }
    }
    restarted.push({ udid: sim.udid, name: sim.name, restarted_bundles: ok });
    if (errors.length) failed.push({ udid: sim.udid, name: sim.name, failures: errors });
  }
  return { restarted, failed };
}

export function watchSimulators({ interval = 5000, certPath, developer_dir, onNew, onResult,
  list = listSimulators, trust = trustCaOnSimulator,
} = {}) {
  let stopped = false;
  let timer = null;
  const reconciled = new Set();
  let ticking = false;
  let pending = Promise.resolve();
  const tick = async () => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      const listed = await list({ scope: 'booted', developer_dir });
      if (!listed.preflight.ok) throw new Error(listed.preflight.recovery ?? 'Simulator tooling unavailable.');
      if (stopped) return;
      const active = new Set(listed.simulators.map((sim) => sim.udid));
      for (const udid of reconciled) if (!active.has(udid)) reconciled.delete(udid);
      for (const sim of listed.simulators.filter((item) => !reconciled.has(item.udid))) {
        if (stopped) break;
        let result;
        try {
          await trust(sim.udid, certPath, { developer_dir: listed.preflight.developer_dir });
          reconciled.add(sim.udid);
          result = { ...sim, status: 'trusted_root_imported' };
          if (!stopped && onNew) await onNew(sim);
        } catch (error) {
          if (isDuplicateCertificateError(error)) {
            reconciled.add(sim.udid);
            result = { ...sim, status: 'already_present_unverified' };
            if (!stopped && onNew) await onNew(sim);
          } else {
            result = { ...sim, status: 'failed', error: classifySimctlError(error) };
          }
        }
        if (!stopped && onResult) await onResult(result);
      }
    } catch (error) {
      if (!stopped && onResult) await onResult({ status: 'watcher_error', error: classifySimctlError(error) });
    } finally {
      ticking = false;
      if (!stopped) timer = setTimeout(schedule, Math.max(2000, interval));
    }
  };
  const schedule = () => { pending = tick().catch(() => {}); };
  schedule();
  return async () => { stopped = true; if (timer) clearTimeout(timer); await pending; };
}

function classifySimctlError(error) {
  const text = `${error?.stderr ?? ''}\n${error?.message ?? error}`.trim();
  let code = 'SIMCTL_OPERATION_FAILED';
  if (/invalid device|unable to lookup|no devices/i.test(text)) code = 'SIMULATOR_UNAVAILABLE';
  else if (/timed out|ETIMEDOUT/i.test(text)) code = 'SIMULATOR_BOOT_TIMEOUT';
  else if (/CoreSimulator|service.*unavailable/i.test(text)) code = 'CORESIMULATOR_UNAVAILABLE';
  else if (/certificate|SecItem|OSStatus/i.test(text)) code = 'CERTIFICATE_IMPORT_FAILED';
  return { code, message: text.slice(0, 2000), exit_code: error?.code ?? null };
}

function isDuplicateCertificateError(error) {
  const text = `${error?.stderr ?? ''}\n${error?.message ?? error}`;
  return /errSecDuplicateItem|\b-25299\b|already exists|duplicate item/i.test(text);
}

function compactError(error) {
  return `${error?.stderr || error?.message || error}`.trim().slice(0, 2000);
}
