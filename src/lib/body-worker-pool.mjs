import { Worker } from 'node:worker_threads';
import { processCapturedBody } from './body-worker-processing.mjs';
import { readEnvironment } from './environment.mjs';
import { createRedactionConfig } from './redaction.mjs';
import { increment } from './metrics.mjs';

function option(value, fallback, maximum) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? Math.min(n, maximum) : fallback;
}

// Queue entries retain the existing buffer; only dispatched jobs are cloned.
// No transfer list: mockttp may still own or reuse the original buffer.
export class BodyWorkerPool {
  constructor({
    threshold = readEnvironment('PROXYFAN_BODY_WORKER_THRESHOLD'),
    size = readEnvironment('PROXYFAN_BODY_WORKERS'),
    queueLimit = readEnvironment('PROXYFAN_BODY_WORKER_QUEUE'),
    timeoutMs = readEnvironment('PROXYFAN_BODY_WORKER_TIMEOUT_MS'),
    workerFactory = () => new Worker(new URL('./body-worker.mjs', import.meta.url)),
  } = {}) {
    this.threshold = option(threshold, 256 * 1024, Number.MAX_SAFE_INTEGER);
    this.size = option(size, 2, 8);
    this.queueLimit = option(queueLimit, 32, 128);
    this.timeoutMs = option(timeoutMs, 5000, 30000);
    this.workerFactory = workerFactory;
    this.workers = new Set();
    this.queue = [];
  }

  process(job) {
    job = { ...job, redactionConfig: createRedactionConfig() };
    // Encoded bodies can inflate above the threshold despite a tiny wire size.
    if (job.buffer.length <= this.threshold && !job.headers?.['content-encoding']) {
      return processCapturedBody(job);
    }
    let slot = [...this.workers].find((entry) => !entry.job);
    if (!slot && this.workers.size >= this.size && this.queue.length >= this.queueLimit) {
      return this.degrade(job);
    }
    if (!slot && this.workers.size < this.size) {
      try { slot = this.spawn(); } catch { return this.degrade(job); }
    }
    return new Promise((resolve) => {
      const entry = { job, resolve };
      // Includes time spent waiting in the queue, bounding retained memory age.
      entry.timer = setTimeout(() => {
        const active = [...this.workers].find((worker) => worker.job === entry);
        if (active) this.fail(active);
        else {
          this.queue = this.queue.filter((queued) => queued !== entry);
          this.finish(entry);
        }
      }, this.timeoutMs);
      if (slot) this.dispatch(slot, entry);
      else this.queue.push(entry);
    });
  }

  spawn() {
    const worker = this.workerFactory();
    const slot = { worker, job: null };
    this.workers.add(slot);
    worker.on('message', (message) => {
      if (!this.workers.has(slot) || !slot.job) return;
      const entry = slot.job;
      slot.job = null;
      this.finish(entry, message?.failed ? undefined : message?.result);
      this.pump();
    });
    worker.on('error', () => this.fail(slot));
    worker.on('exit', () => this.fail(slot));
    worker.unref(); // Idle workers must never keep a bridge or test alive.
    return slot;
  }

  dispatch(slot, entry) {
    slot.job = entry;
    try { slot.worker.postMessage(entry.job); } catch { this.fail(slot); }
  }

  finish(entry, result) {
    clearTimeout(entry.timer);
    // resolve assimilates the safe fallback promise. Never expose raw input.
    entry.resolve(result ?? this.degrade(entry.job));
  }

  fail(slot) {
    if (!this.workers.delete(slot)) return;
    const terminated = slot.worker.terminate();
    terminated?.catch(() => {});
    if (slot.job) this.finish(slot.job);
    this.pump();
  }

  pump() {
    while (this.queue.length) {
      let slot = [...this.workers].find((entry) => !entry.job);
      if (!slot && this.workers.size < this.size) {
        try { slot = this.spawn(); } catch { this.finish(this.queue.shift()); continue; }
      }
      if (!slot) return;
      this.dispatch(slot, this.queue.shift());
    }
  }

  async degrade(job) {
    increment('proxy.body_offload_degraded');
    if (job.buffer.length < 1024 * 1024) {
      try { return await processCapturedBody(job); } catch { /* omit on fallback failure */ }
    }
    return {
      inline: null, path: null, size: job.buffer.length, sha: null, encoding: 'binary',
      original_size: job.buffer.length, redacted: false, omitted: 'processing_overloaded', decoded: false,
    };
  }

  async close() {
    const slots = [...this.workers];
    this.workers.clear();
    for (const entry of this.queue.splice(0)) this.finish(entry);
    for (const slot of slots) if (slot.job) this.finish(slot.job);
    await Promise.allSettled(slots.map((slot) => slot.worker.terminate()));
  }
}
