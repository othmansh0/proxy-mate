// Isolated WP14 microbenchmark. Run with a temporary PROXY_MATE_HOME.
// One job at a time, two workers maximum, no CPU burners, capped at 60 seconds.
// Baseline reproduces the pre-WP14 decode/redact/hash/spill path.
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
if (!process.env.PROXY_MATE_HOME) throw new Error('Set PROXY_MATE_HOME to an isolated temporary directory');
const { BodyWorkerPool } = await import('../src/lib/body-worker-pool.mjs');
const { storeFlowBody } = await import('../src/lib/bodies.mjs');
const { redactBody } = await import('../src/lib/redaction.mjs');
const pool = new BodyWorkerPool();
const started = performance.now();
const headers = { 'content-type': 'application/json' };
const output = { node: process.version, load_average: os.loadavg(), samples: [] };
try {
  // Warm worker startup outside measurements.
  await pool.process({ buffer: Buffer.alloc(300000, 'x'), headers, flowId: 'warm', kind: 'res', captureBodyMode: 'text' });
  for (const mb of [2, 5]) {
    const body = Buffer.from(JSON.stringify({ token: 'synthetic-secret', data: 'x'.repeat(mb * 1024 * 1024 - 100) }));
    for (const mode of ['before', 'after']) {
      const lag = monitorEventLoopDelay({ resolution: 1 });
      lag.enable();
      await delay(25);
      const start = performance.now();
      for (let i = 0; i < 24; i++) {
        if (performance.now() - started > 55000) throw new Error('benchmark time limit exceeded');
        await delay(1);
        const flowId = `bench-${mb}-${mode}`;
        if (mode === 'before') {
          const text = body.toString('utf8');
          if (Buffer.byteLength(text, 'utf8') !== body.length) throw new Error('bad fixture');
          await storeFlowBody(Buffer.from(redactBody(text, headers)), flowId, 'res');
        } else {
          await pool.process({ buffer: body, headers, flowId, kind: 'res', captureBodyMode: 'text' });
        }
      }
      await delay(25);
      lag.disable();
      output.samples.push({ mb, mode, elapsed_ms: Math.round(performance.now() - start), p99_ms: +(lag.percentile(99) / 1e6).toFixed(3), max_ms: +(lag.max / 1e6).toFixed(3) });
    }
  }
  console.log(JSON.stringify(output, null, 2));
} finally {
  await pool.close();
}
