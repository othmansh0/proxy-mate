import http from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import diagnosticsChannel from 'node:diagnostics_channel';
import { setTimeout as delay } from 'node:timers/promises';

export function loadError(code, message) {
  return Object.assign(new Error(message), { code, retryable: false, recovery: ['Check the harness options and retry with light settings.'] });
}

export function parseOptions(argv) {
  const config = { seconds: 60, cpuFactor: 0, bridges: 4, subscriptions: false, backgroundBand: false,
    guardian: false, assertNoKill: false, allowKill: false, upstreamLatencyMs: 50, concurrency: 16, json: null };
  const flags = { '--subscriptions': 'subscriptions', '--background-band': 'backgroundBand', '--guardian': 'guardian', '--assert-no-kill': 'assertNoKill', '--allow-kill': 'allowKill' };
  const values = { '--seconds': 'seconds', '--cpu-factor': 'cpuFactor', '--bridges': 'bridges', '--upstream-latency-ms': 'upstreamLatencyMs', '--concurrency': 'concurrency', '--json': 'json' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flags[flag]) config[flags[flag]] = true;
    else if (values[flag] && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      const key = values[flag]; config[key] = key === 'json' ? argv[++i] : Number(argv[++i]);
    } else throw loadError('INVALID_LOAD_OPTIONS', `Unknown option or missing value: ${flag}`);
  }
  for (const key of ['seconds', 'cpuFactor', 'bridges', 'upstreamLatencyMs', 'concurrency']) {
    const value = config[key];
    if (!Number.isFinite(value) || value < (['seconds', 'concurrency'].includes(key) ? 1 : 0)
      || (['bridges', 'concurrency'].includes(key) && !Number.isSafeInteger(value))) {
      throw loadError('INVALID_LOAD_OPTIONS', `Invalid ${key}: ${value}`);
    }
  }
  return config;
}

export function summarize(events) {
  const outcomes = {};
  for (const { outcome } of events) outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  const values = events.map(e => e.latency_ms).sort((a, b) => a - b);
  const percentile = p => values.length ? values[Math.max(0, Math.ceil(values.length * p) - 1)] : null;
  return { total: events.length, success: outcomes.ok ?? 0, failures: events.length - (outcomes.ok ?? 0), outcomes,
    latency_ms: { p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: values.at(-1) ?? null } };
}

export function failsQualification(report) {
  return report.guardian.timeline.some(e => e.action === 'restart_requested' || e.action.startsWith('terminating'))
    || report.requests.total === 0 || report.requests.failures / report.requests.total > .01;
}

export function outcome(error) {
  if (/TIMEOUT|ETIMEDOUT/.test(error?.code)) return 'timeout';
  if (error?.code === 'RATE_LIMITED') return 'HTTP_429';
  if (error?.code === 'CONTROL_BUSY') return 'HTTP_503';
  return error?.code ?? 'other';
}

export async function stopChild(child, graceMs = 20000) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const closed = new Promise(resolve => child.once('close', resolve));
  child.kill('SIGTERM');
  const controller = new AbortController();
  try {
    await Promise.race([closed, delay(graceMs, null, { signal: controller.signal }).then(() => child.kill('SIGKILL'))]);
    await closed;
  } finally { controller.abort(); }
}

export function request(options, { timeoutMs = 2000, signal, maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ ...options, signal }, res => {
      let bytes = 0; const chunks = [];
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) req.destroy(loadError('RESPONSE_TOO_LARGE', 'Load response exceeds limit'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    const timer = setTimeout(() => req.destroy(loadError('ETIMEDOUT', 'Load request deadline exceeded')), timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
  });
}

export async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}

export async function closeServer(server) {
  if (!server) return;
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}

// Async context associates real module requests with their operation, without
// wrapping http or adding traffic that could itself exhaust a control bucket.
export function createHttpObserver() {
  const context = new AsyncLocalStorage();
  const channel = diagnosticsChannel.channel('http.client.response.finish');
  const listener = ({ response }) => {
    const current = context.getStore();
    if (current) current.status = response.statusCode;
  };
  channel.subscribe(listener);
  return {
    async run(fn) {
      const record = { status: null };
      return context.run(record, async () => {
        try { return { value: await fn(), status: record.status }; }
        catch (error) { return { error, status: record.status }; }
      });
    },
    close() { channel.unsubscribe(listener); context.disable(); },
  };
}
