import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { callDaemon } from '../src/lib/control.mjs';

test('running daemon uses custom --pac-port for agent routing with a fake network runner', { timeout: 20000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'daemon-custom-pac-'));
  const reservations = [];
  for (let i = 0; i < 3; i++) {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    reservations.push(server);
  }
  const [proxyPort, pacPort, controlPort] = reservations.map(s => s.address().port);
  await Promise.all(reservations.map(s => new Promise(resolve => s.close(resolve))));
  // Inject only the network runner, service selection and CA-status read. Never
  // allow the regression to bind a production port even on the unfixed code.
  const loader = path.join(directory, 'fake-network-loader.mjs');
  await fs.writeFile(loader, `
export async function load(url, context, next) {
  const result = await next(url, context);
  if (url.endsWith('/src/lib/pac.mjs')) {
    let source = String(result.source);
    source = source.replace("const NETWORKSETUP =", \`let auto = { enabled: false, url: '' };
const fakeRun = async (_file, args) => {
  if (args[0] === '-getautoproxyurl') return { stdout: 'URL: ' + auto.url + '\\\\nEnabled: ' + (auto.enabled ? 'Yes' : 'No') + '\\\\n' };
  if (args[0] === '-setautoproxyurl') auto.url = args[2];
  if (args[0] === '-setautoproxystate') auto.enabled = args[2] === 'on';
  return { stdout: 'Enabled: No\\\\n' };
};
const NETWORKSETUP =\`);
    source = source.replaceAll('run = execFileP', 'run = fakeRun');
    source = source.replace('return selectNetworkService(preferred);', "return preferred ?? 'Fake';");
    source = source.replace('async start(port) {', "async start(port) { if ([8080, 8081, 8082].includes(port)) throw new Error('Production port forbidden in regression');");
    return { ...result, source };
  }
  if (url.endsWith('/src/lib/tools.mjs')) return { ...result,
    source: String(result.source).replace('hostCertificateStatus = getHostCertificateStatus', 'hostCertificateStatus = async () => ({ trusted: true, ok: true })') };
  return result;
}
`);
  const child = spawn(process.execPath, ['--loader', pathToFileURL(loader).href,
    'src/server.mjs', '--daemon', '--no-routing', '--no-host-trust', '--no-trust-ca',
    '--network-service', 'Fake', '--proxy-port', String(proxyPort), '--pac-port', String(pacPort), '--control-port', String(controlPort)],
  { cwd: new URL('../', import.meta.url), env: { ...process.env, PROXYFAN_HOME: directory }, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  child.stderr.on('data', data => { errors += data; });
  const finished = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    await finished;
    await fs.rm(directory, { recursive: true, force: true });
  });
  let handshake;
  for (let i = 0; i < 200; i++) {
    assert.equal(child.exitCode, null, errors);
    try { handshake = JSON.parse(await fs.readFile(path.join(directory, 'handshake.json'), 'utf8')); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(handshake, errors);
  await callDaemon({ ...handshake, tool: 'set_proxy_routing', args: { domains: ['custom.example'] } });
  const state = JSON.parse(await fs.readFile(path.join(directory, 'state.json'), 'utf8'));
  assert.equal(state.pac_port, pacPort);
  assert.equal(state.pac_url, `http://127.0.0.1:${pacPort}/proxy.pac`);
  assert.match(await (await fetch(state.pac_url)).text(), /custom\.example/);
  child.kill('SIGTERM');
  assert.deepEqual(await finished, { code: 0, signal: null }, errors);
});
