import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs, constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';
import * as mockttp from 'mockttp';
import { STATE_DIR } from './config.mjs';
import { listSimulators } from './sim.mjs';

const exec = promisify(execFile);
const source = fileURLToPath(new URL('../../scripts/simulator-probe.swift', import.meta.url));
let compilation = Promise.resolve();

async function buildProbe(preflight, signal) {
  const env = { ...process.env, DEVELOPER_DIR: preflight.developer_dir };
  const options = { env, signal, timeout: 120_000, maxBuffer: 1024 * 1024 };
  const sdk = (await exec('/usr/bin/xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], options)).stdout.trim();
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  const digest = crypto.createHash('sha256').update(await fs.readFile(source)).update(sdk + arch + preflight.xcode_version).digest('hex').slice(0, 24);
  const directory = path.join(STATE_DIR, 'simulator-probe');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const binary = path.join(directory, `probe-${digest}`);
  try { await fs.access(binary, constants.X_OK); return binary; } catch { /* compile */ }
  const temporary = `${binary}.${crypto.randomUUID()}`;
  try {
    await exec('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-sdk', sdk,
      '-target', `${arch}-apple-ios15.0-simulator`, '-module-cache-path', path.join(directory, 'modules'),
      source, '-o', temporary], options);
    await fs.chmod(temporary, 0o700);
    await fs.rename(temporary, binary);
    return binary;
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

export async function verifySimulatorCertificate({ udid, keyPath, certPath, developer_dir, signal } = {}) {
  const listed = await listSimulators({ scope: 'booted', device_ids: [udid], developer_dir });
  if (!listed.preflight.ok) return { ok: false, system_tls_verified: false, preflight: listed.preflight };
  if (!listed.simulators.some((sim) => sim.udid === udid)) {
    throw Object.assign(new Error('Boot the specified simulator before verifying its certificate.'), { code: 'SIMULATOR_NOT_BOOTED' });
  }
  const build = compilation.catch(() => {}).then(() => buildProbe(listed.preflight, signal));
  compilation = build.catch(() => {});
  const binary = await build;
  const proxy = mockttp.getLocal({ https: { keyPath, certPath }, recordTraffic: false, suggestChanges: false });
  const nonce = crypto.randomBytes(24).toString('hex');
  try {
    await proxy.start(0);
    proxy.server?.prependListener('connection', (socket) => {
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(socket.remoteAddress)) socket.destroy();
    });
    const target = `https://proxy-mcp-verify.invalid/${nonce}`;
    await proxy.forGet(target).thenReply(200, nonce, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    const { stdout } = await exec('/usr/bin/xcrun', ['simctl', 'spawn', udid, binary, String(proxy.port), target, nonce], {
      env: { ...process.env, DEVELOPER_DIR: listed.preflight.developer_dir }, signal, timeout: 25_000, maxBuffer: 64 * 1024,
    });
    const result = JSON.parse(stdout.trim().split('\n').at(-1));
    return {
      ...result, device_id: udid, checked_at: new Date().toISOString(),
      automatic_routing_verified: false,
      verification: 'Native simulator URLSession over an explicit loopback proxy, using system TLS trust. Automatic PAC routing and app-specific pinning are separate checks.',
      ...(!result.ok ? { recovery: 'Run setup_simulator_certificate for this device and retry. For a manually installed profile, enable full trust in Simulator Settings.' } : {}),
    };
  } finally { await proxy.stop(); }
}
