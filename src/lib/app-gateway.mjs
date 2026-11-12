import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

function destination(authority) {
  const target = new URL(`http://${authority}`);
  if (target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('Invalid CONNECT target.');
  return { host: target.hostname.replace(/^\[|\]$/g, ''), port: Number(target.port || 443) };
}

function requestHead(request, url = request.url) {
  const headers = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (/^proxy-authorization$/i.test(request.rawHeaders[index])) continue;
    headers.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
  }
  return `${request.method} ${url} HTTP/${request.httpVersion}\r\n${headers.join('\r\n')}\r\n\r\n`;
}

export class AppProxyGateway {
  constructor({ proxyPort, classify }) {
    this.proxyPort = proxyPort;
    this.classify = classify;
    this.server = null;
    this.port = null;
    this.sockets = new Set();
    this.identities = new WeakMap();
    this.counts = { selected: 0, other: 0, unknown: 0 };
    this.httpAgent = new http.Agent({ keepAlive: true });
    this.httpsAgent = new https.Agent({ keepAlive: true });
  }

  async start(port = 8080) {
    if (this.server) throw new Error('App capture gateway is already running.');
    const server = http.createServer((request, response) => {
      void this.forwardHttp(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
    });
    server.maxConnections = 128;
    server.on('connection', (socket) => this.track(socket));
    server.on('connect', (request, socket, head) => {
      void this.forwardTunnel(request, socket, head).catch(() => socket.destroy());
    });
    server.on('upgrade', (request, socket, head) => {
      void this.forwardUpgrade(request, socket, head).catch(() => socket.destroy());
    });
    server.on('clientError', (_error, socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    this.server = server;
    this.port = server.address().port;
    return this.port;
  }

  track(socket) {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    socket.on('error', () => {});
  }

  identity(socket) {
    if (!this.identities.has(socket)) {
      const result = Promise.resolve().then(() => this.classify(socket)).catch(() => 'unknown').then((identity) => {
        const known = ['selected', 'other'].includes(identity) ? identity : 'unknown';
        this.counts[known] += 1;
        return known;
      });
      this.identities.set(socket, result);
    }
    return this.identities.get(socket);
  }

  async forwardHttp(request, response) {
    const selected = await this.identity(request.socket) === 'selected';
    if (!this.server || request.destroyed) return;
    const url = new URL(request.url);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported proxy protocol.');
    const headers = { ...request.headers };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const transport = selected || url.protocol === 'http:' ? http : https;
    const target = selected
      ? { hostname: '127.0.0.1', port: this.proxyPort, path: request.url }
      : { hostname: url.hostname, port: url.port || undefined, path: url.pathname + url.search };
    const upstream = transport.request({ ...target, method: request.method, headers,
      agent: transport === http ? this.httpAgent : this.httpsAgent }, (received) => {
      response.writeHead(received.statusCode ?? 502, received.rawHeaders);
      received.pipe(response);
      received.on('error', () => response.destroy());
    });
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.once('aborted', () => upstream.destroy());
    response.once('close', () => { if (!response.writableFinished) upstream.destroy(); });
    request.pipe(upstream);
  }

  async forwardTunnel(request, socket, head) {
    const selected = await this.identity(socket) === 'selected';
    if (!this.server || socket.destroyed) return;
    const target = selected ? { host: '127.0.0.1', port: this.proxyPort } : destination(request.url);
    const upstream = net.connect(target);
    this.track(upstream);
    upstream.setTimeout(15_000, () => upstream.destroy());
    upstream.once('connect', () => {
      upstream.setTimeout(0);
      if (selected) upstream.write(requestHead(request));
      else socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.once('error', () => socket.destroy());
    socket.once('close', () => upstream.destroy());
    upstream.once('close', () => socket.destroy());
  }

  async forwardUpgrade(request, socket, head) {
    const selected = await this.identity(socket) === 'selected';
    if (!this.server || socket.destroyed) return;
    const url = new URL(request.url);
    if (!['ws:', 'http:'].includes(url.protocol)) throw new Error('Unsupported WebSocket proxy target.');
    const target = selected
      ? { host: '127.0.0.1', port: this.proxyPort }
      : { host: url.hostname, port: Number(url.port || 80) };
    const upstream = net.connect(target);
    this.track(upstream);
    upstream.once('connect', () => {
      upstream.write(requestHead(request, selected ? request.url : url.pathname + url.search));
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.once('error', () => socket.destroy());
    socket.once('close', () => upstream.destroy());
    upstream.once('close', () => socket.destroy());
  }

  status() {
    const attribution = this.classify.status?.() ?? null;
    return { port: this.port, connections: { ...this.counts },
      attribution,
      coverage_degraded: attribution?.coverage === 'degraded',
      unknown_connections: 'Passed through without inspection or storage. These are capture omissions, not persistence drops.' };
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.port = null;
    const closed = new Promise((resolve) => server.close(resolve));
    for (const socket of this.sockets) socket.destroy();
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
    server.closeAllConnections();
    await closed;
  }
}
