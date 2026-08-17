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

const execFileP = promisify(execFile);

const LABEL = 'dev.proxy-mcp.daemon';
const LEGACY_LABEL = 'com.almosafer.proxy-mcp';
const PLIST_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
const PLIST_PATH = path.join(PLIST_DIR, `${LABEL}.plist`);
const LEGACY_PLIST_PATH = path.join(PLIST_DIR, `${LEGACY_LABEL}.plist`);
const LOG_DIR = path.join(STATE_DIR, 'logs');

export { LABEL, PLIST_PATH };

function plistXml({ programArgs }) {
  const argsXml = programArgs.map((a) => `    <string>${escapeXml(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
    <key>Crashed</key><true/>
  </dict>
  <key>ExitTimeOut</key>
  <integer>20</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${path.join(LOG_DIR, 'daemon.out.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(LOG_DIR, 'daemon.err.log')}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
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

export async function installLaunchAgent({ nodeBin, serverPath, domainsFile, proxyPort, pacPort, controlPort, extraArgs = [] }) {
  await fs.mkdir(PLIST_DIR, { recursive: true });
  await fs.mkdir(LOG_DIR, { recursive: true });
  const programArgs = [
    nodeBin || process.execPath,
    serverPath,
    '--daemon',
  ];
  if (proxyPort) programArgs.push('--proxy-port', String(proxyPort));
  if (pacPort)   programArgs.push('--pac-port', String(pacPort));
  if (controlPort) programArgs.push('--control-port', String(controlPort));
  if (domainsFile) programArgs.push('--domains-file', domainsFile);
  for (const a of extraArgs) programArgs.push(a);

  await fs.writeFile(PLIST_PATH, plistXml({ programArgs }), { mode: 0o600 });

  // Upgrade older development installs that used an organization-specific
  // label. This only runs when the user explicitly invokes `install`.
  if (existsSync(LEGACY_PLIST_PATH)) {
    try { await execFileP('launchctl', ['bootout', `gui/${process.getuid()}`, LEGACY_PLIST_PATH]); } catch { /* not loaded */ }
    try { await fs.unlink(LEGACY_PLIST_PATH); } catch { /* best effort */ }
  }

  // bootout first (idempotent) so we re-load fresh args.
  try { await execFileP('launchctl', ['bootout', `gui/${process.getuid()}`, PLIST_PATH]); }
  catch { /* may not be loaded */ }
  await execFileP('launchctl', ['bootstrap', `gui/${process.getuid()}`, PLIST_PATH]);
  return { plistPath: PLIST_PATH, label: LABEL, programArgs };
}

export async function uninstallLaunchAgent() {
  const removed = [];
  for (const plistPath of [PLIST_PATH, LEGACY_PLIST_PATH]) {
    if (!existsSync(plistPath)) continue;
    try { await execFileP('launchctl', ['bootout', `gui/${process.getuid()}`, plistPath]); } catch { /* may not be loaded */ }
    try { await fs.unlink(plistPath); removed.push(plistPath); } catch { /* ignore */ }
  }
  return removed.length ? { removed: true, plistPaths: removed } : { removed: false, reason: 'not installed' };
}

export async function launchAgentStatus() {
  const activePath = existsSync(PLIST_PATH) ? PLIST_PATH : (existsSync(LEGACY_PLIST_PATH) ? LEGACY_PLIST_PATH : null);
  const activeLabel = activePath === LEGACY_PLIST_PATH ? LEGACY_LABEL : LABEL;
  if (!activePath) return { installed: false };
  try {
    const { stdout } = await execFileP('launchctl', ['print', `gui/${process.getuid()}/${activeLabel}`]);
    return { installed: true, plistPath: activePath, label: activeLabel, legacy: activeLabel === LEGACY_LABEL, launchctl_state: stdout.slice(0, 400) };
  } catch (e) {
    return { installed: true, plistPath: activePath, label: activeLabel, legacy: activeLabel === LEGACY_LABEL, launchctl_state: `not loaded (${e?.message ?? e})` };
  }
}
