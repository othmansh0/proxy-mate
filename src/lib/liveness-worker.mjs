// Only the heartbeat is shared atomically; progress arrives as whole snapshots.
// SIGSTOP freezes every thread, including this listener, so a guardian can still
// detect a process-wide hang when the independent endpoint stops responding.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';

const { buffer, token, port, pid, startedAt, progress: initialProgress } = workerData;
const heartbeat = new BigInt64Array(buffer);
const authorization = Buffer.from(`Bearer ${token}`);
let progress = initialProgress;
parentPort.on('message', message => { progress = message; });

const server = http.createServer((req, res) => {
  const supplied = Buffer.from(req.headers.authorization ?? '');
  // Compare fixed-size values even when the supplied credential has the wrong length.
  const candidate = Buffer.alloc(authorization.length);
  supplied.copy(candidate, 0, 0, candidate.length);
  const authenticated = timingSafeEqual(authorization, candidate) && supplied.length === authorization.length;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Connection', 'close');
  res.setHeader('Cache-Control', 'no-store');
  if (!authenticated) {
    res.writeHead(401).end('{"error":"UNAUTHORIZED"}');
    return;
  }
  if (req.method !== 'GET' || req.url !== '/livez') {
    res.writeHead(404).end('{"error":"NOT_FOUND"}');
    return;
  }
  const now = Date.now();
  const age = Math.max(0, now - Number(Atomics.load(heartbeat, 0)));
  res.end(JSON.stringify({
    ok: true, service: 'proxyfan-liveness', pid,
    heartbeat_age_ms: age,
    verdict: age < 1000 ? 'healthy' : age < 30000 ? 'slow' : 'stalled',
    progress: {
      flows_completed: progress.flows_completed,
      bytes: progress.bytes,
      active_connections: progress.active_connections,
    },
    lag_p99_ms: progress.lag_p99_ms, elu: progress.elu,
    uptime_ms: Math.max(0, now - startedAt),
  }));
});
server.requestTimeout = 1000;
server.headersTimeout = 1000;
server.maxConnections = 16;
server.listen(port, '127.0.0.1', () => {
  parentPort.postMessage({ url: `http://127.0.0.1:${server.address().port}/livez` });
});
