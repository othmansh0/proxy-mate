// LaunchAgent install/uninstall — per-user, no root needed. Files live under
// ~/Library/LaunchAgents. We bootstrap with `launchctl bootstrap gui/$UID`
// (modern domain) which keeps the daemon alive across terminal closes,
// MCP-server restarts, and Claude Code restarts.

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { STATE_DIR } from './config.mjs';
import { serviceEnvironment } from './environment.mjs';
import { readHandshake, atomicWriteFile } from './state.mjs';
import { probeDaemon } from './control.mjs';
import { stageDaemonRuntime, pruneDaemonRuntimes, publishDaemonRuntime } from './runtime-install.mjs';
import lockfile from 'proper-lockfile';
import { activateServiceFiles } from './service-install.mjs';

const execFileP = promisify(execFile);
const LAUNCHCTL_OPTIONS = { timeout: 30_000, maxBuffer: 1024 * 1024 };

const LABEL = 'dev.proxy-mate.daemon';
const GUARDIAN_LABEL = 'dev.proxy-mate.guardian';
export const LEGACY_SERVICE_LABELS = Object.freeze([
  'dev.proxy-mcp.daemon', 'dev.proxy-mcp.guardian', 'com.almosafer.proxy-mcp',
]);
const PLIST_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
const PLIST_PATH = path.join(PLIST_DIR, `${LABEL}.plist`);
function legacyServices(directory = PLIST_DIR) {
  return LEGACY_SERVICE_LABELS.map((label) => ({ label, plistPath: path.join(directory, `${label}.plist`) }));
}
const GUARDIAN_PLIST_PATH = path.join(PLIST_DIR, `${GUARDIAN_LABEL}.plist`);
const LOG_DIR = path.join(STATE_DIR, 'logs');

export { LABEL, PLIST_PATH, GUARDIAN_LABEL, GUARDIAN_PLIST_PATH };

export function plistXml({ programArgs, environment = {}, label = LABEL, logPrefix = 'daemon', processType = 'Standard' }) {
  const argsXml = programArgs.map((a) => `    <string>${escapeXml(a)}</string>`).join('\n');
  const env = {
    PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    ...environment,
    PROXY_MATE_HOME: STATE_DIR,
  };
  const envXml = Object.entries(env).map(([key, value]) => `    <key>${escapeXml(key)}</key><string>${escapeXml(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>WorkingDirectory</key>
  <string>${escapeXml(path.dirname(path.dirname(programArgs[1])))}</string>
  <key>ExitTimeOut</key>
  <integer>20</integer>
  <key>ProcessType</key>
  <string>${escapeXml(processType)}</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(LOG_DIR, `${logPrefix}.out.log`))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(LOG_DIR, `${logPrefix}.err.log`))}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
</dict>
</plist>
`;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function installLaunchAgent(options, dependencies = {}) {
  await fs.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(path.join(STATE_DIR, 'install'), { realpath: false, stale: 30_000, update: 5_000 });
  try { return await installLaunchAgentUnlocked(options, dependencies); }
  finally { await release(); }
}

async function installLaunchAgentUnlocked({ nodeBin, serverPath, domainsFile, proxyPort, pacPort, controlPort, extraArgs = [], readinessTimeoutMs = 90000 }, {
  plistDir = PLIST_DIR, stage = stageDaemonRuntime, read = readHandshake,
  run = (args) => execFileP('launchctl', args, LAUNCHCTL_OPTIONS),
  ready = waitForDaemonReady, publish = publishDaemonRuntime, prune = pruneDaemonRuntimes,
} = {}) {
  const plistPath = path.join(plistDir, `${LABEL}.plist`);
  const guardianPlistPath = path.join(plistDir, `${GUARDIAN_LABEL}.plist`);
  await fs.mkdir(plistDir, { recursive: true });
  await fs.mkdir(LOG_DIR, { recursive: true });
  const runtime = await stage({ serverPath });
  const programArgs = [
    await stableNodePath(nodeBin || process.execPath),
    runtime.serverPath,
    '--daemon',
  ];
  if (proxyPort) programArgs.push('--proxy-port', String(proxyPort));
  if (pacPort)   programArgs.push('--pac-port', String(pacPort));
  if (controlPort) programArgs.push('--control-port', String(controlPort));
  if (domainsFile) programArgs.push('--domains-file', path.resolve(domainsFile));
  for (const a of extraArgs) programArgs.push(a);

  const environment = serviceEnvironment();
  // Retain the previous CWD authorization boundary for explicit fixture reads.
  // Files under protected folders may still require macOS user permission.
  environment.PROXY_MATE_ALLOWED_PATHS = [runtime.sourceRoot, environment.PROXY_MATE_ALLOWED_PATHS].filter(Boolean).join(path.delimiter);
  const previousHandshake = await read();
  const guardianArgs = [programArgs[0], path.join(runtime.directory, 'src/guardian.mjs')];
  // The daemon serves interactive Simulator traffic: Background throttles it
  // under build load (see man launchd.plist, ProcessType).
  let mcpServerPath;
  try { mcpServerPath = await activateServiceFiles({
    services: [
      { label: LABEL, plistPath, xml: plistXml({ programArgs, environment, processType: 'Interactive' }) },
      { label: GUARDIAN_LABEL, plistPath: guardianPlistPath,
        xml: plistXml({ programArgs: guardianArgs, environment, label: GUARDIAN_LABEL, logPrefix: 'guardian', processType: 'Standard' }) },
    ],
    retired: legacyServices(plistDir).filter((service) => existsSync(service.plistPath)),
    domain: `gui/${process.getuid()}`,
    run,
    ready: () => ready({ previousToken: previousHandshake?.token, timeoutMs: readinessTimeoutMs }),
    publish: () => publish(runtime.directory),
  }); } catch (error) {
    // A failed build must not displace the previous healthy snapshot in
    // retention. Preserve it only when recovery itself needs investigation.
    if (error.details?.rollback_restored) await fs.rm(runtime.directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  await prune(runtime.directory).catch((error) => process.stderr.write(`[proxy-mate] old runtime cleanup failed: ${error.message}\n`));
  return { plistPath, label: LABEL, programArgs, runtime_directory: runtime.directory,
    mcp_server_path: mcpServerPath, mcp_client_path: path.join(path.dirname(mcpServerPath), 'client.mjs'),
    guardian: { label: GUARDIAN_LABEL, plistPath: guardianPlistPath }, ready: true };
}

export async function stableNodePath(executable) {
  const real = await fs.realpath(executable);
  for (const candidate of ['/opt/homebrew/opt/node@24/bin/node', '/opt/homebrew/opt/node@22/bin/node', '/opt/homebrew/bin/node', '/usr/local/bin/node']) {
    if (await fs.realpath(candidate).catch(() => null) === real) return candidate;
  }
  return path.resolve(executable);
}

export async function waitForDaemonReady({ previousToken, timeoutMs = 90_000,
  read = readHandshake, probe = probeDaemon,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const handshake = await read();
    if (handshake && handshake.token !== previousToken && await probe(handshake.controlUrl, handshake.token)) return true;
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
  }
  throw Object.assign(new Error(`LaunchAgent was loaded but did not become ready. Check ${path.join(LOG_DIR, 'daemon.err.log')} and run proxy-mate status.`), { code: 'DAEMON_STARTUP_TIMEOUT' });
}

export async function uninstallLaunchAgent() {
  const removed = [];
  for (const plistPath of [GUARDIAN_PLIST_PATH, PLIST_PATH, ...legacyServices().reverse().map((service) => service.plistPath)]) {
    if (!existsSync(plistPath)) continue;
    try { await execFileP('launchctl', ['bootout', `gui/${process.getuid()}`, plistPath], LAUNCHCTL_OPTIONS); } catch { /* may not be loaded */ }
    try { await fs.unlink(plistPath); removed.push(plistPath); } catch { /* ignore */ }
  }
  return removed.length ? { removed: true, plistPaths: removed } : { removed: false, reason: 'not installed' };
}

export async function launchAgentStatus() {
  const active = [{ label: LABEL, plistPath: PLIST_PATH }, ...legacyServices().filter((service) => !service.label.endsWith('.guardian'))]
    .find((service) => existsSync(service.plistPath));
  if (!active) return { installed: false };
  const { label: activeLabel, plistPath: activePath } = active;
  try {
    const { stdout } = await execFileP('launchctl', ['print', `gui/${process.getuid()}/${activeLabel}`], LAUNCHCTL_OPTIONS);
    return { installed: true, plistPath: activePath, label: activeLabel, legacy: activeLabel !== LABEL, launchctl_state: stdout.slice(0, 400) };
  } catch (e) {
    return { installed: true, plistPath: activePath, label: activeLabel, legacy: activeLabel !== LABEL, launchctl_state: `not loaded (${e?.message ?? e})` };
  }
}
