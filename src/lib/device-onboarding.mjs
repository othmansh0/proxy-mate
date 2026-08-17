import crypto from 'node:crypto';
import { X509Certificate } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const DEFAULT_TTL_MS = 15 * 60 * 1000;

export function listLanAddresses() {
  const results = [];
  for (const [interfaceName, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      results.push({ interface: interfaceName, address: address.address, netmask: address.netmask });
    }
  }
  return results;
}

export function physicalDeviceInstructions({ addresses = listLanAddresses(), proxyPort, portalPort, token }) {
  const portalUrls = addresses.map(({ address }) => `http://${address}:${portalPort}/${token}/`);
  return {
    supported_devices: ['iPhone', 'iPad', 'Apple Watch', 'Apple TV', 'Vision Pro'],
    proxy: { port: proxyPort, candidates: addresses },
    portal_urls: portalUrls,
    automated: ['CA generation', 'certificate download portal', 'LAN address discovery', 'proxy endpoint discovery'],
    manual_required: [
      'Connect the Mac and device to the same trusted network.',
      'On the device Wi-Fi network, configure HTTP Proxy manually using one candidate address and the proxy port.',
      'Open the temporary portal URL in Safari and install the downloaded profile.',
      'Open Settings > General > About > Certificate Trust Settings and enable full trust for proxy-mcp CA.',
    ],
    safety: [
      'Stop the onboarding portal after installation.',
      'Remove the proxy and certificate from the physical device when debugging is complete.',
      'Do not expose the proxy on an untrusted LAN without an IP allowlist.',
    ],
  };
}

export class DeviceOnboardingPortal {
  #server = null;
  #timer = null;
  #token = null;
  #proxyPort = null;

  async start({ certPath, proxyPort, port = 0, ttlMs = DEFAULT_TTL_MS } = {}) {
    if (this.#server) return this.status();
    if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
      throw codedError('INVALID_PROXY_PORT', 'A running proxy port is required for physical-device onboarding.');
    }
    const certificate = new X509Certificate(await fs.readFile(certPath)).raw;
    this.#token = crypto.randomBytes(24).toString('base64url');
    const token = this.#token;
    const server = http.createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      if (request.method !== 'GET') return reply(response, 405, 'Method Not Allowed');
      const base = `/${token}`;
      if (request.url === `${base}/cert` || request.url === `${base}/cert.der`) {
        response.writeHead(200, {
          'Content-Type': 'application/x-x509-ca-cert',
          'Content-Disposition': 'attachment; filename="proxy-mcp-ca.der"',
          'Content-Length': certificate.length,
        });
        return response.end(certificate);
      }
      if (request.url === `${base}` || request.url === `${base}/`) {
        const html = onboardingHtml({ token, proxyPort });
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
        return response.end(html);
      }
      return reply(response, 404, 'Not Found');
    });
    server.requestTimeout = 10_000;
    server.headersTimeout = 5_000;
    server.keepAliveTimeout = 5_000;
    server.maxRequestsPerSocket = 10;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '0.0.0.0', resolve);
    });
    this.#server = server;
    this.#proxyPort = proxyPort;
    this.#timer = setTimeout(() => this.stop().catch(() => {}), Math.max(60_000, ttlMs));
    this.#timer.unref?.();
    return this.status();
  }

  status() {
    if (!this.#server) return { running: false };
    const address = this.#server.address();
    return {
      running: true,
      portal_port: typeof address === 'object' ? address.port : null,
      ...physicalDeviceInstructions({ proxyPort: this.#proxyPort, portalPort: address.port, token: this.#token }),
    };
  }

  async stop() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (!this.#server) return { status: 'not_running' };
    const server = this.#server;
    this.#server = null;
    this.#token = null;
    this.#proxyPort = null;
    await new Promise((resolve) => server.close(resolve));
    return { status: 'stopped' };
  }
}

function onboardingHtml({ token, proxyPort }) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>proxy-mcp iOS setup</title></head><body><main><h1>proxy-mcp device setup</h1><p>Proxy port: <strong>${proxyPort}</strong></p><ol><li>Configure this Wi-Fi network's HTTP proxy to the Mac address shown in your MCP result and port ${proxyPort}.</li><li><a href="/${token}/cert.der">Download proxy-mcp CA</a> and install the profile.</li><li>Open Settings &gt; General &gt; About &gt; Certificate Trust Settings and enable full trust.</li><li>Return to your development app and run the MCP diagnostic.</li></ol><p>Remove the proxy and certificate when debugging is complete.</p></main></body></html>`;
}

function reply(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
