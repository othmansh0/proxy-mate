import { promises as fs } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { STATE_DIR, atomicWriteJson } from './state.mjs';
import { snapshotMetrics } from './metrics.mjs';

function progressSnapshot() {
  const { counters, gauges } = snapshotMetrics();
  const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
  return {
    flows_completed: finite(counters['proxy.flows_completed'], 0),
    bytes: finite(counters['proxy.bytes'], 0),
    active_connections: finite(gauges['proxy.active_connections'], 0),
    lag_p99_ms: finite(gauges['loop.lag_p99_ms'], null),
    elu: finite(gauges['loop.elu'], null),
  };
}

// Await once at daemon startup, then await stop() during cleanup.
export async function startLiveness({ directory = STATE_DIR, heartbeatMs = 100, publishMs = 500, port = 0 } = {}) {
  if (![heartbeatMs, publishMs].every(value => Number.isInteger(value) && value > 0)) {
    throw Object.assign(new Error('Liveness intervals must be positive integers'), { code: 'INVALID_INTERVAL' });
  }
  const buffer = new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT);
  const heartbeat = new BigInt64Array(buffer);
  const beat = () => Atomics.store(heartbeat, 0, BigInt(Date.now()));
  beat();
  const token = randomBytes(32).toString('hex');
  const startedAt = Date.now();
  const file = path.join(directory, 'liveness.json');
  const worker = new Worker(new URL('./liveness-worker.mjs', import.meta.url), {
    workerData: { buffer, token, port, pid: process.pid, startedAt, progress: progressSnapshot() },
    // Main-thread CLI flags (including --input-type and test-runner flags)
    // need not be valid Worker flags. This standalone worker needs none.
    execArgv: [],
  });
  let stopping;
  const heartbeatTimer = setInterval(beat, heartbeatMs);
  const publishTimer = setInterval(() => worker.postMessage(progressSnapshot()), publishMs);
  heartbeatTimer.unref();
  publishTimer.unref();
  async function removeOwnedFile() {
    let record;
    try { record = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error instanceof SyntaxError) return; throw error; }
    if (record.pid === process.pid && record.token === token) {
      try { await fs.unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  function stop() {
    stopping ??= (async () => {
      clearInterval(heartbeatTimer);
      clearInterval(publishTimer);
      await worker.terminate();
      await removeOwnedFile();
    })();
    return stopping;
  }
  // After startup an unexpected exit makes probes fail; consume the error and
  // stop publishing rather than crashing the daemon with an unhandled event.
  worker.on('error', () => { clearInterval(heartbeatTimer); clearInterval(publishTimer); });
  worker.on('exit', () => { clearInterval(heartbeatTimer); clearInterval(publishTimer); });
  try {
    const { url } = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => failed(Object.assign(new Error('Liveness worker startup timed out'), { code: 'LIVENESS_START_TIMEOUT' })), 10_000);
      const cleanup = () => { clearTimeout(timer); worker.off('error', failed); worker.off('exit', exited); worker.off('message', ready); };
      const failed = error => { cleanup(); reject(error); };
      const exited = code => failed(Object.assign(new Error(`Liveness worker exited during startup (${code})`), { code: 'LIVENESS_WORKER_EXIT' }));
      const ready = message => { cleanup(); resolve(message); };
      worker.once('error', failed); worker.once('exit', exited); worker.once('message', ready);
    });
    await atomicWriteJson(file, { url, token, pid: process.pid, started_at: new Date(startedAt).toISOString() }, 0o600);
    worker.unref();
    return { url, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

export async function probeLiveness({ directory = STATE_DIR, timeoutMs = 1000, read = fs.readFile } = {}) {
  try {
    const record = JSON.parse(await read(path.join(directory, 'liveness.json'), 'utf8'));
    const url = new URL(record.url);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
        url.username || url.password || url.search || url.hash ||
        !['/', '/livez'].includes(url.pathname) || typeof record.token !== 'string' || !record.token) return null;
    url.pathname = '/livez';
    return await new Promise(resolve => {
      let settled = false;
      const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
      const req = http.get(url, { agent: false, headers: { Authorization: `Bearer ${record.token}` } }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          body += chunk;
          if (body.length > 8192) { finish(null); req.destroy(); }
        });
        res.on('error', () => finish(null));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            finish(res.statusCode === 200 && parsed?.ok === true && parsed.service === 'proxyfan-liveness' ? parsed : null);
          } catch { finish(null); }
        });
      });
      const timer = setTimeout(() => { finish(null); req.destroy(); }, timeoutMs);
      req.on('error', () => finish(null));
    });
  } catch { return null; }
}
