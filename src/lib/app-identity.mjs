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

export function createAppClassifier({ appPath, verifyProcess = async () => true, execute = executeFile, realpath = fs.realpath }) {
  const selectedPath = path.resolve(appPath);
  let pending = 0;
  return async (socket) => {
    if (socket.remoteAddress !== '127.0.0.1' || !socket.remotePort || !socket.localPort || pending >= 16) return 'unknown';
    pending += 1;
    try {
      const { stdout } = await execute('/usr/sbin/lsof', [
        '-nP', '-a', `-iTCP:${socket.remotePort}`, '-sTCP:ESTABLISHED', '-Fpn',
      ], { timeout: 2000, maxBuffer: 256 * 1024 });
      const pid = findConnectionOwner(stdout, socket.remotePort, socket.localPort);
      if (!pid) return 'unknown';
      if (!await verifyProcess(pid)) return 'other';
      const result = await execute('/bin/ps', ['-p', String(pid), '-o', 'comm='], { timeout: 1000, maxBuffer: 16 * 1024 });
      const executable = result.stdout.trim();
      if (!path.isAbsolute(executable)) return 'unknown';
      const [actual, selected] = await Promise.all([realpath(executable), realpath(selectedPath)]);
      return actual.startsWith(selected + path.sep) ? 'selected' : 'other';
    } catch {
      return 'unknown';
    } finally {
      pending -= 1;
    }
  };
}
