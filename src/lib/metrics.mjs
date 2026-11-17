// In-process counters and gauges for diagnostics. Deliberately tiny: no
// labels, no exporters. Each subsystem increments named counters; status and
// /health read one snapshot. Names are dotted, e.g. 'control.rate_limited'.
//
// Agreed names (keep them stable; the liveness worker and harness read them):
//   proxy.flows_completed, proxy.bytes (counters), proxy.active_connections (gauge),
//   proxy.requests_aborted, proxy.connections_dropped, proxy.capture_dropped,
//   gateway.connections_dropped, control.rate_limited, control.busy,
//   control.connections_dropped, loop.lag_p50_ms, loop.lag_p99_ms, loop.lag_max_ms,
//   loop.elu (gauges).

const counters = new Map();
const gauges = new Map();

export function increment(name, by = 1) {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

// A gauge is read lazily at snapshot time. Re-registering replaces it.
export function registerGauge(name, read) {
  gauges.set(name, read);
  return () => { if (gauges.get(name) === read) gauges.delete(name); };
}

export function snapshotMetrics() {
  const out = { counters: Object.fromEntries(counters), gauges: {} };
  for (const [name, read] of gauges) {
    try { out.gauges[name] = read(); } catch { out.gauges[name] = null; }
  }
  return out;
}

// Tests only.
export function resetMetrics() { counters.clear(); gauges.clear(); }
