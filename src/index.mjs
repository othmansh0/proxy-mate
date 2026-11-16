// The library only talks to an existing daemon. Importing it installs no
// services, signal handlers, routing, certificates or capture resources.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './lib/config.mjs';
import { callDaemon } from './lib/control.mjs';
import { waitForReadyDaemon } from './lib/daemon-connection.mjs';
import { rememberCaptureLease } from './lib/capture-lease.mjs';

export function createProxyClient({ home = STATE_DIR, readyTimeoutMs = 15_000 } = {}) {
  if (typeof home !== 'string' || !path.isAbsolute(home)
    || !Number.isInteger(readyTimeoutMs) || readyTimeoutMs < 0 || readyTimeoutMs > 60_000) {
    throw new TypeError('Use an absolute home path and readyTimeoutMs from 0 to 60000.');
  }
  const read = async () => {
    try { return JSON.parse(await fs.readFile(path.join(home, 'handshake.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const dispatch = rememberCaptureLease(async (tool, args, { signal, timeoutMs } = {}) => {
    const handshake = await waitForReadyDaemon({ timeoutMs: readyTimeoutMs, signal, read });
    if (!handshake) throw Object.assign(new Error('Proxy Mate is unavailable. Run proxy-mate init, then retry after the daemon is ready.'), {
      code: 'DAEMON_UNAVAILABLE', retryable: true,
    });
    // The handshake is refreshed before every call. A submitted mutation is
    // never retried after an ambiguous transport failure.
    return callDaemon({ ...handshake, tool, args, signal, timeoutMs });
  });
  return Object.freeze({
    callTool(name, args = {}, options = {}) {
      if (typeof name !== 'string' || !name) return Promise.reject(new TypeError('A tool name is required.'));
      if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 300_000)) {
        return Promise.reject(new TypeError('timeoutMs must be an integer from 1 to 300000.'));
      }
      return dispatch(name, args, options);
    },
  });
}
