import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activateServiceFiles } from '../src/lib/service-install.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-service-rollback-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const services = ['daemon', 'guardian'].map((label) => ({ label, plistPath: path.join(root, `${label}.plist`), xml: `new-${label}` }));
  const jobs = new Set();
  const run = async ([command, , file]) => {
    if (command === 'bootstrap') jobs.add(path.basename(file, '.plist'));
    else if (command === 'bootout') jobs.delete(path.basename(file, '.plist'));
  };
  const runner = async (args) => {
    if (args[0] === 'print') { if (!jobs.has(args[1].split('/').at(-1))) throw new Error('not loaded'); return; }
    return run(args);
  };
  return { services, jobs, run: runner, domain: 'gui/test' };
}

test('failed daemon readiness restores exact previous plists and loaded jobs', async (t) => {
  const deps = await fixture(t);
  for (const s of deps.services) await fs.writeFile(s.plistPath, `old-${s.label}`);
  deps.jobs.add('daemon'); deps.jobs.add('guardian');
  await assert.rejects(activateServiceFiles({ ...deps, ready: async () => { throw new Error('new build failed'); }, publish: async () => assert.fail('must not publish') }), (error) => {
    assert.equal(error.details.rollback_restored, true); return true;
  });
  for (const s of deps.services) assert.equal(await fs.readFile(s.plistPath, 'utf8'), `old-${s.label}`);
  assert.deepEqual([...deps.jobs].sort(), ['daemon', 'guardian']);
});

test('failed first install leaves no service files or jobs behind', async (t) => {
  const deps = await fixture(t);
  await assert.rejects(activateServiceFiles({ ...deps, ready: async () => { throw new Error('failed'); }, publish: async () => {} }));
  assert.equal(deps.jobs.size, 0);
  for (const s of deps.services) await assert.rejects(fs.access(s.plistPath), { code: 'ENOENT' });
});

test('publication happens after daemon readiness and guardian activation', async (t) => {
  const deps = await fixture(t); let ready = false;
  const result = await activateServiceFiles({ ...deps, ready: async () => { ready = true; assert.equal(deps.jobs.has('guardian'), false); },
    publish: async () => { assert.equal(ready, true); assert.equal(deps.jobs.has('guardian'), true); return 'published'; } });
  assert.equal(result, 'published');
});
