// proxy-mcp doctor — port-based orphan detection and safe kill.
//
// Critical rule: only SIGTERM/SIGKILL processes whose `ps -p PID -o comm=` is
// "node" (our binary is node + server.mjs). Never `pkill -f` — that matches
// any command-line substring and is famous for collateral kills.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readPidFile } from './state.mjs';
import { PROXY_PORT_DEFAULT, PAC_PORT_DEFAULT, CONTROL_PORT_DEFAULT } from './config.mjs';

const execFileP = promisify(execFile);

// Recognise the executable as a node process. macOS `ps -p PID -o comm=`
// returns the full path (e.g. `/opt/homebrew/bin/node`), so we match on
// basename. Anything else requires `force: true`.
function isOurCommand(comm) {
  if (!comm) return false;
  const base = comm.split('/').pop();
  return base === 'node' || base === 'node-mac' || /^node[\d.]*$/.test(base ?? '');
}

export async function scanPorts(ports = [PROXY_PORT_DEFAULT, PAC_PORT_DEFAULT, CONTROL_PORT_DEFAULT]) {
  const occupants = [];
  for (const port of ports) {
    const holders = await lsofForPort(port);
    for (const holder of holders) {
      occupants.push({ port, ...holder });
    }
  }
  return occupants;
}

async function lsofForPort(port) {
  try {
    const { stdout } = await execFileP('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
    const pids = stdout
      .split('\n')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n));
    const out = [];
    for (const pid of pids) {
      out.push({ pid, comm: await commForPid(pid) });
    }
    return out;
  } catch { return []; }
}

async function commForPid(pid) {
  try {
    const { stdout } = await execFileP('/bin/ps', ['-p', String(pid), '-o', 'comm=']);
    return stdout.trim();
  } catch { return null; }
}

async function argsForPid(pid) {
  try {
    const { stdout } = await execFileP('/bin/ps', ['-p', String(pid), '-o', 'args=']);
    return stdout.trim();
  } catch { return null; }
}

// Probe whether a TCP port responds. Returns true if connect() succeeds.
export async function portIsListening(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    import('node:net').then(({ Socket }) => {
      const s = new Socket();
      let done = false;
      const finish = (ok) => { if (done) return; done = true; try { s.destroy(); } catch {}; resolve(ok); };
      s.setTimeout(500);
      s.once('connect', () => finish(true));
      s.once('error',   () => finish(false));
      s.once('timeout', () => finish(false));
      s.connect(port, host);
    });
  });
}

// Kill PIDs holding our ports, with safety checks.
export async function killOrphans({ ports, force = false, exclude_pid = process.pid } = {}) {
  const targets = await scanPorts(ports);
  const recordedPid = await readPidFile();
  const results = [];
  for (const t of targets) {
    if (t.pid === exclude_pid) {
      results.push({ ...t, action: 'skip-self' });
      continue;
    }
    const args = await argsForPid(t.pid);
    const identityMatches = isOurCommand(t.comm)
      && t.pid === recordedPid
      && /(?:^|[/\s])server\.mjs(?:\s|$)/.test(args ?? '')
      && /(?:^|\s)--daemon(?:\s|$)/.test(args ?? '');
    const isOurs = identityMatches || force;
    if (!isOurs) {
      results.push({ ...t, args: args?.slice(0, 500) ?? null, action: 'skip-unverified-owner' });
      continue;
    }
    const killed = await terminate(t.pid);
    results.push({ ...t, action: killed.action, ok: killed.ok });
  }
  return results;
}

async function terminate(pid) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    if (e.code === 'ESRCH') return { action: 'already-gone', ok: true };
    return { action: 'sigterm-error', ok: false, error: e.message };
  }
  // wait up to ~5s for the process to exit gracefully
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    if (!processAlive(pid)) return { action: 'sigterm', ok: true };
  }
  // SIGKILL fallback
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  await sleep(100);
  return { action: processAlive(pid) ? 'sigkill-failed' : 'sigkill', ok: !processAlive(pid) };
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// One-shot doctor sweep: scan, kill orphans, return a report. Used by the
// `proxy-mcp doctor` CLI subcommand and the kill_orphan_proxy MCP tool.
export async function doctorSweep({ ports, force = false } = {}) {
  const before = await scanPorts(ports);
  const killed = await killOrphans({ ports, force });
  const after = await scanPorts(ports);
  const pidFile = await readPidFile();
  return {
    scanned_ports: ports ?? [PROXY_PORT_DEFAULT, PAC_PORT_DEFAULT, CONTROL_PORT_DEFAULT],
    before,
    killed,
    after,
    pid_file: pidFile,
  };
}

export { PROXY_PORT_DEFAULT, PAC_PORT_DEFAULT, CONTROL_PORT_DEFAULT };
