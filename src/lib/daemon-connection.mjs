import { readHandshake } from './state.mjs';
import { probeDaemon } from './control.mjs';

// Keep cache ownership per bridge, never across unrelated callers.
export function createDaemonReadiness(options = {}) {
  const cache = { handshake: null, succeededAt: -Infinity };
  const now = options.now ?? Date.now;
  return {
    waitForReady: (overrides = {}) => waitForReadyDaemon({ ...options, ...overrides, cache }),
    recordSuccess(handshake) {
      cache.handshake = { token: handshake.token, controlUrl: handshake.controlUrl };
      cache.succeededAt = now();
    },
  };
}

// Wait only before dispatching an RPC. Never replay a submitted mutation: a
// dropped connection cannot establish whether the daemon committed it.
export async function waitForReadyDaemon({
  timeoutMs = 0, signal, read = readHandshake, probe = probeDaemon,
  now = Date.now, random = Math.random, delay = abortableDelay, cache, client,
} = {}) {
  const deadline = now() + timeoutMs;
  let backoffMs = 100;
  for (;;) {
    if (signal?.aborted) throw cancellationError();
    const handshake = await read();
    if (signal?.aborted) throw cancellationError();
    if (cache?.handshake?.token === handshake?.token
      && cache?.handshake?.controlUrl === handshake?.controlUrl
      && handshake && now() - cache.succeededAt < 2000) return handshake;
    const remaining = Math.max(0, deadline - now());
    const probeTimeout = timeoutMs === 0 ? 1500 : Math.min(1500, Math.max(1, remaining));
    if (handshake && await probe(handshake.controlUrl, handshake.token, probeTimeout, client)) {
      if (signal?.aborted) throw cancellationError();
      return handshake;
    }
    if (cache) { cache.handshake = null; cache.succeededAt = -Infinity; }
    if (now() >= deadline) return null;
    await delay(Math.min(backoffMs * (0.8 + random() * 0.4), deadline - now()), signal);
    backoffMs = Math.min(1000, backoffMs * 2);
  }
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve();
    };
    const abort = () => finish(cancellationError());
    const timer = setTimeout(() => finish(), ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function cancellationError() {
  return Object.assign(new Error('Daemon readiness wait was cancelled.'), { code: 'REQUEST_CANCELLED', retryable: true });
}
