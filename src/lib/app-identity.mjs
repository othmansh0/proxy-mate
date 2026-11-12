import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const executeFile = promisify(execFile);

export function findConnectionOwner(output, clientPort, proxyPort) {
  let pid = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    if (!line.startsWith('n') || !Number.isSafeInteger(pid) || pid < 1) continue;
    const endpoints = line.slice(1).split('->');
    if (endpoints.length !== 2) continue;
    if (endpoints[0] === `127.0.0.1:${clientPort}` && endpoints[1] === `127.0.0.1:${proxyPort}`) return pid;
  }
  return null;
}

export function createAppClassifier({
  appPath, resolveAppPath, verifyProcess = async () => true,
  execute = executeFile, realpath = fs.realpath, maxPending = 128,
}) {
  let selectedPath = path.resolve(appPath);
  let draining = false;
  let pending = 0;
  const queue = [];
  const counts = { selected: 0, other: 0, unknown: 0 };
  const reasons = {};
  let lastUnknownAt = null;
  let pathRefreshes = 0;

  function finish(job, identity, reason) {
    if (job.queued) { pending -= 1; job.queued = false; }
    counts[identity] += 1;
    if (identity === 'unknown') {
      lastUnknownAt = Date.now();
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    }
    job.resolve(identity);
  }

  async function drain() {
    // Each batch gets a fresh socket snapshot. Do not cache owner/PID decisions
    // across batches: ports and process IDs can be reused after an app exits.
    while (queue.length) {
      const batch = queue.splice(0, maxPending);
      const groups = Map.groupBy(batch, (job) => job.socket.localPort);
      for (const [port, jobs] of groups) {
        let stdout;
        try {
          ({ stdout } = await execute('/usr/sbin/lsof', [
            '-nP', '-a', `-iTCP:${port}`, '-sTCP:ESTABLISHED', '-Fpn',
          ], { timeout: 2000, maxBuffer: 256 * 1024 }));
        } catch {
          for (const job of jobs) finish(job, 'unknown', 'socket_lookup_failed');
          continue;
        }
        const processes = new Map();
        let refresh;
        const inspect = async (pid) => {
          try {
            if (!await verifyProcess(pid)) return 'other';
            const result = await execute('/bin/ps', ['-p', String(pid), '-o', 'comm='], { timeout: 1000, maxBuffer: 16 * 1024 });
            const executable = result.stdout.trim();
            if (!path.isAbsolute(executable)) return 'unknown';
            const actual = await realpath(executable);
            let selected = await realpath(selectedPath).catch(() => null);
            if (selected && actual.startsWith(selected + path.sep)) return 'selected';
            // A Simulator reinstall can replace the app container. Re-resolve
            // only after verifying the selected Simulator and bundle process.
            if (resolveAppPath) {
              refresh ??= Promise.resolve().then(resolveAppPath).then((value) => {
                selectedPath = path.resolve(value);
                pathRefreshes += 1;
                return realpath(selectedPath);
              });
              selected = await refresh;
              if (actual.startsWith(selected + path.sep)) return 'selected';
            }
            return 'other';
          } catch { return 'unknown'; }
        };
        await Promise.all(jobs.map(async (job) => {
          const pid = findConnectionOwner(stdout, job.socket.remotePort, port);
          if (!pid) { finish(job, 'unknown', 'socket_owner_missing'); return; }
          if (!processes.has(pid)) processes.set(pid, inspect(pid));
          const identity = await processes.get(pid);
          finish(job, identity, 'process_verification_failed');
        }));
      }
    }
    draining = false;
  }

  const classify = (socket) => new Promise((resolve) => {
    const job = { socket, resolve };
    if (socket.remoteAddress !== '127.0.0.1' || !socket.remotePort || !socket.localPort) {
      finish(job, 'unknown', 'unsupported_socket'); return;
    }
    if (pending >= maxPending) { finish(job, 'unknown', 'queue_full'); return; }
    pending += 1;
    job.queued = true;
    queue.push(job);
    if (!draining) {
      draining = true;
      queueMicrotask(() => void drain());
    }
  });
  classify.status = () => ({
    pending, max_pending: maxPending, connections: { ...counts }, unknown_reasons: { ...reasons },
    app_path_refreshes: pathRefreshes,
    coverage: lastUnknownAt && Date.now() - lastUnknownAt < 60_000 ? 'degraded' : counts.selected ? 'observed' : 'unverified',
    last_unknown_at: lastUnknownAt ? new Date(lastUnknownAt).toISOString() : null,
  });
  return classify;
}
