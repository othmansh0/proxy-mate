import { readHandshake } from './state.mjs';
import { probeDaemon } from './control.mjs';

// Wait only before dispatching an RPC. Never replay a submitted mutation: a
// dropped connection cannot establish whether the daemon committed it.
export async function waitForReadyDaemon({
  timeoutMs = 0, signal, read = readHandshake, probe = probeDaemon,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw cancellationError();
    const handshake = await read();
    const remaining = Math.max(0, deadline - Date.now());
    const probeTimeout = timeoutMs === 0 ? 1500 : Math.min(1500, Math.max(1, remaining));
    if (handshake && await probe(handshake.controlUrl, handshake.token, probeTimeout)) {
      if (signal?.aborted) throw cancellationError();
      return handshake;
    }
    if (Date.now() >= deadline) return null;
    await abortableDelay(Math.min(100, deadline - Date.now()), signal);
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
