#!/usr/bin/env node

import { performance } from 'node:perf_hooks';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SessionStore } from '../src/lib/session-store.mjs';

const requested = Number.parseInt(process.argv[2] ?? '10000', 10);
const flowCount = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 100_000) : 10_000;
const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'proxyfan-storage-benchmark-'));
const store = new SessionStore({
  rootDir,
  retention: { max_flows: flowCount + 1, max_bytes: 2 * 1024 * 1024 * 1024, max_age_ms: 86_400_000 },
});

try {
  await store.createSession({ id: 'benchmark', name: 'Storage benchmark' });
  const appendStarted = performance.now();
  for (let index = 0; index < flowCount; index++) {
    await store.appendFlow({
      sessionId: 'benchmark',
      flow: {
        id: `flow-${index}`,
        request: {
          method: 'GET',
          url: `https://benchmark.invalid/items/${index}`,
          headers: { accept: 'application/json' },
        },
      },
    });
  }
  const appendMs = performance.now() - appendStarted;

  const updateStarted = performance.now();
  for (let index = 0; index < flowCount; index++) {
    await store.updateFlow({
      sessionId: 'benchmark',
      flowId: `flow-${index}`,
      patch: { response: { statusCode: 200, body_inline: '{"ok":true}' } },
    });
  }
  const updateMs = performance.now() - updateStarted;

  const readStarted = performance.now();
  let cursor = null;
  let readCount = 0;
  do {
    const page = await store.listFlows({ sessionId: 'benchmark', cursor, limit: 1000 });
    readCount += page.flows.length;
    cursor = page.next_cursor;
  } while (cursor);
  const pagedReadMs = performance.now() - readStarted;

  // Model many in-flight captures without changing the sequential baseline.
  await store.createSession({ id: 'burst' });
  const burstStarted = performance.now();
  for (let offset = 0; offset < flowCount; offset += 64) {
    await Promise.all(Array.from({ length: Math.min(64, flowCount - offset) }, (_, i) =>
      store.appendFlow({ sessionId: 'burst', flow: { id: `burst-${offset + i}`, request: { method: 'GET', url: 'https://benchmark.invalid/burst' } } })));
  }
  const burstMs = performance.now() - burstStarted;

  process.stdout.write(`${JSON.stringify({
    flow_count: flowCount,
    burst_append_ms: round(burstMs),
    burst_append_per_second: round(flowCount / (burstMs / 1000)),
    append_ms: round(appendMs),
    append_per_second: round(flowCount / (appendMs / 1000)),
    update_ms: round(updateMs),
    update_per_second: round(flowCount / (updateMs / 1000)),
    paged_read_ms: round(pagedReadMs),
    read_count: readCount,
    storage: await store.storageStatus(),
  }, null, 2)}\n`);
} finally {
  await store.close();
}

function round(value) { return Math.round(value * 100) / 100; }
