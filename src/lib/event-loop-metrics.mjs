import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { registerGauge } from './metrics.mjs';

export function startEventLoopMetrics({ intervalMs = 5000, resolutionMs = 20 } = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs <= 0 ||
      !Number.isInteger(resolutionMs) || resolutionMs <= 0) {
    throw Object.assign(new Error('Loop metric intervals must be positive integers'), { code: 'INVALID_INTERVAL' });
  }
  const histogram = monitorEventLoopDelay({ resolution: resolutionMs });
  let previous = performance.eventLoopUtilization();
  let snapshot = { lag_p50_ms: null, lag_p99_ms: null, lag_max_ms: null, elu: null };
  const unregister = Object.keys(snapshot).map(key => registerGauge(`loop.${key}`, () => snapshot[key]));
  histogram.enable();
  const timer = setInterval(() => {
    const current = performance.eventLoopUtilization();
    snapshot = {
      lag_p50_ms: histogram.count ? histogram.percentile(50) / 1e6 : null,
      lag_p99_ms: histogram.count ? histogram.percentile(99) / 1e6 : null,
      lag_max_ms: histogram.count ? histogram.max / 1e6 : null,
      elu: performance.eventLoopUtilization(current, previous).utilization,
    };
    previous = current;
    histogram.reset();
  }, intervalMs);
  timer.unref();
  return {
    latest: () => ({ ...snapshot }),
    stop() {
      clearInterval(timer);
      histogram.disable();
      for (const remove of unregister) remove();
    },
  };
}
