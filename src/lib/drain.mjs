import { Server } from 'node:net';
import { readEnvironment } from './environment.mjs';
import { logLine } from './log-line.mjs';

export function defaultDrainMs() {
  const value = Number(readEnvironment('PROXY_MATE_DRAIN_MS') ?? 8000);
  return Number.isFinite(value) && value >= 0 ? value : 8000;
}

// mockttp 4.6.x uses httpolyglot: the listener is a net.Server, while
// HTTP idle/all-connection cleanup lives on its internal http.Server.
export function mockttpListener(mock) {
  const server = mock?.server;
  if (!(server instanceof Server) || !server._httpServer
      || typeof server._httpServer.closeIdleConnections !== 'function'
      || typeof server._httpServer.closeAllConnections !== 'function'
      || typeof server.destroy !== 'function') {
    throw Object.assign(new Error('mockttp listener internals changed; re-audit the drain adapter.'), { code: 'MOCKTTP_INTERNALS_CHANGED' });
  }
  return server;
}

function closeResponse(response) {
  if (response.headersSent || response.destroyed) return;
  response.shouldKeepAlive = false;
  response.setHeader('Connection', 'close');
  if (response.drainWriteHead) return;
  const writeHead = response.writeHead;
  response.drainWriteHead = true;
  response.writeHead = function (...args) {
    const index = typeof args[1] === 'string' ? 2 : 1;
    const headers = args[index];
    if (Array.isArray(headers)) {
      const filtered = [];
      for (let i = 0; i < headers.length; i += 2) {
        if (headers[i].toLowerCase() !== 'connection') filtered.push(headers[i], headers[i + 1]);
      }
      args[index] = filtered;
      args[index].push('Connection', 'close');
    } else if (headers && typeof headers === 'object') {
      args[index] = Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'connection'));
      args[index].Connection = 'close';
    }
    return writeHead.apply(this, args);
  };
}

export function trackServer(server) {
  const sockets = new Set();
  const responses = new Set();
  const connection = (socket) => {
    if (sockets.has(socket)) return;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  const request = (_request, response) => {
    responses.add(response);
    response.once('close', () => responses.delete(response));
  };
  server.on('connection', connection);
  server.on('request', request);
  return { sockets, responses, dispose() {
    server.removeListener('connection', connection);
    server.removeListener('request', request);
  } };
}

export async function drainServer(server, { graceMs = defaultDrainMs(), sockets = new Set(), responses = new Set(), intervalMs = 250, now = Date.now } = {}) {
  if (!Number.isFinite(graceMs) || graceMs < 0) throw new TypeError('graceMs must be a non-negative finite number.');
  const started = now();
  const initial = [...sockets].filter(s => !s.destroyed).length;
  const http = server._httpServer ?? server;
  const mark = (_req, res) => closeResponse(res);
  server.on('request', mark);
  let closed = false;
  const closing = new Promise((resolve, reject) => server.close(error => {
    closed = true;
    if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error); else resolve();
  }));
  for (const response of responses) closeResponse(response);
  for (const socket of sockets) {
    if (socket._httpMessage) closeResponse(socket._httpMessage);
  }
  let destroyed = 0;
  let timer;
  let deadline;
  try {
    http.closeIdleConnections?.();
    await Promise.race([closing, new Promise(resolve => {
      const force = () => {
        const remaining = [...sockets].filter(s => !s.destroyed);
        destroyed = remaining.length;
        http.closeAllConnections?.();
        for (const socket of remaining) socket.destroy();
        resolve();
      };
      if (graceMs <= 0) return force();
      timer = setInterval(() => http.closeIdleConnections?.(), Math.max(1, intervalMs));
      deadline = setTimeout(force, graceMs);
    })]);
    // Destruction is synchronous; waiting for the listener's close callback
    // additionally lets socket close handlers settle before mockttp.stop().
    if (!closed) await closing;
    return { drained: Math.max(0, initial - destroyed), destroyed, elapsed_ms: Math.max(0, now() - started) };
  } finally {
    clearInterval(timer); clearTimeout(deadline);
    server.removeListener('request', mark);
  }
}

// Fixed windows, with a trailing summary even if no more events arrive.
export function limitedLog(component, message, { now = Date.now, write, limit = 20, windowMs = 10_000 } = {}) {
  let count = 0, suppressed = 0, started = now(), timer;
  const summary = () => {
    if (suppressed) logLine(component, `${message} suppressed`, { suppressed_count: suppressed }, { write });
    suppressed = 0; count = 0; started = now(); timer = null;
  };
  const log = fields => {
    if (now() - started >= windowMs) { clearTimeout(timer); summary(); }
    if (!timer) { timer = setTimeout(summary, windowMs); timer.unref?.(); }
    if (count++ < limit) logLine(component, message, fields, { write }); else suppressed++;
  };
  log.flush = () => { clearTimeout(timer); summary(); };
  return log;
}
