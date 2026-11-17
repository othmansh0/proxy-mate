import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validateCustomCaPaths } from '../src/lib/ca-paths.mjs';
import { plistXml, installLaunchAgent, LABEL, GUARDIAN_LABEL } from '../src/lib/launchagent.mjs';

const priorities = [[LABEL, 'Interactive'], [GUARDIAN_LABEL, 'Standard']];
for (const [label, processType] of priorities) {
  test(`plist preserves service settings with ${processType} priority for ${label}`, () => {
    const xml = plistXml({ programArgs: ['/node', '/runtime/src/server.mjs'], label, processType });
    assert.match(xml, new RegExp(`<key>ProcessType</key>\\s*<string>${processType}</string>`));
    for (const [key, value] of [['ExitTimeOut', 20], ['ThrottleInterval', 10]]) {
      assert.match(xml, new RegExp(`<key>${key}</key>\\s*<integer>${value}</integer>`));
    }
    for (const key of ['KeepAlive', 'RunAtLoad']) assert.match(xml, new RegExp(`<key>${key}</key>\\s*<true/>`));
  });
}

for (const mode of ['fresh', 'upgrade', 'legacy migration']) {
  test(`${mode} install writes both service priorities using a fake launchctl runner`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-priority-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const jobs = new Set();
    const oldLabels = mode === 'legacy migration' ? ['dev.proxy-mcp.daemon', 'dev.proxy-mcp.guardian'] : mode === 'upgrade' ? [LABEL, GUARDIAN_LABEL] : [];
    for (const label of oldLabels) {
      await fs.writeFile(path.join(root, `${label}.plist`), 'old Background plist');
      jobs.add(label);
    }
    await installLaunchAgent({ serverPath: '/fixture/src/server.mjs', ...(mode === 'upgrade' ? { pacPort: 43210 } : {}) }, {
      plistDir: root,
      stage: async () => ({ directory: root, serverPath: path.join(root, 'src/server.mjs'), sourceRoot: root }),
      read: async () => null,
      run: async ([command, target, file]) => {
        if (command === 'print') { if (!jobs.has(target.split('/').at(-1))) throw new Error('not loaded'); }
        else if (command === 'bootstrap') jobs.add(path.basename(file, '.plist'));
        else if (command === 'bootout') jobs.delete(path.basename(file, '.plist'));
        else assert.fail(`unexpected service operation ${command}`);
      },
      ready: async () => true,
      publish: async () => path.join(root, 'current/src/server.mjs'),
      prune: async () => {},
    });
    for (const [label, processType] of priorities) {
      const xml = await fs.readFile(path.join(root, `${label}.plist`), 'utf8');
      assert.match(xml, /<key>PROXY_MATE_PAC_HOST<\/key><string>guardian<\/string>/);
      assert.ok(xml.includes(`<key>PROXY_MATE_PAC_PORT</key><string>${mode === 'upgrade' ? 43210 : 8081}</string>`));
      assert.match(xml, new RegExp(`<key>ProcessType</key>\\s*<string>${processType}</string>`));
    }
    assert.deepEqual([...jobs].sort(), [LABEL, GUARDIAN_LABEL].sort());
    if (mode === 'legacy migration') for (const label of oldLabels) await assert.rejects(fs.access(path.join(root, `${label}.plist`)), { code: 'ENOENT' });
  });
}

// Evaluate only the install entry point: importing the CLI would start main().
// Side-effecting lexical dependencies are replaced so a regression cannot touch services.
async function installHarness() {
  const source = await fs.readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function runInstall('), source.indexOf('\nasync function runUninstall('))
    .replaceAll('import.meta.url', JSON.stringify(new URL('../src/server.mjs', import.meta.url).href));
  const errors = [];
  const unexpected = async () => assert.fail('CA validation must precede certificate setup or service installation');
  const bindings = { validateCustomCaPaths, connectionAttemptTimeout() {}, url: await import('node:url'), fs,
    loadDomainsConfig: async () => ({ domains: [], tls_passthrough: [] }), validateRoutingDomains() {},
    ensureCA: unexpected, setupHostCertificate: unexpected, installLaunchAgent: unexpected,
    CA_CERT: '/unused', process: { execPath: process.execPath, stderr: { write: (text) => errors.push(text) } } };
  const create = new Function(...Object.keys(bindings), `${body}; return runInstall;`);
  return { run: create(...Object.values(bindings)), errors };
}

for (const [kind, stat] of [
  ['EPERM', async () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); }],
  ['missing', async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }],
  ['directory', async () => ({ isFile: () => false })],
]) {
  test(`install rejects ${kind} CA before any install side effect with structured recovery`, async () => {
    const { run, errors } = await installHarness();
    await assert.rejects(run({ caKeyPath: '/fixture/key', caCertPath: '/fixture/cert' }, { stat }), (error) => {
      assert.equal(error.code, 'CUSTOM_CA_UNREADABLE');
      assert.ok(error.recovery.length);
      return true;
    });
    const error = JSON.parse(errors[0]);
    assert.equal(error.code, 'CUSTOM_CA_UNREADABLE');
    assert.equal(error.details.key_path, '/fixture/key');
    assert.match(error.message, /fixture\/key/);
    assert.ok(error.recovery.some((hint) => hint.includes('existing regular files')));
    if (kind === 'EPERM') assert.ok(error.recovery.some((hint) => hint.includes('Full Disk Access')));
  });
}
