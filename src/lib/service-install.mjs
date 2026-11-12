import { promises as fs } from 'node:fs';
import { atomicWriteFile } from './state.mjs';

// Stage files before calling this. On any activation/readiness failure, restore
// exact previous plists and only jobs that had actually been loaded.
export async function activateServiceFiles({ services, retired = [], domain, run, ready, publish }) {
  const previous = [];
  for (const service of [...services, ...retired]) {
    const body = await fs.readFile(service.plistPath).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    let loaded = false;
    try { await run(['print', `${domain}/${service.label}`]); loaded = true; } catch { /* not loaded */ }
    previous.push({ ...service, body, loaded });
  }
  const attempted = [];
  try {
    for (const old of [...previous].reverse()) if (old.loaded) await run(['bootout', domain, old.plistPath]);
    for (const service of services) await atomicWriteFile(service.plistPath, service.xml, 0o600);
    for (const old of retired) await fs.rm(old.plistPath, { force: true });
    for (let index = 0; index < services.length; index++) {
      attempted.push(services[index]);
      await run(['bootstrap', domain, services[index].plistPath]);
      if (index === 0) await ready();
    }
    return await publish();
  } catch (error) {
    const failures = [];
    for (const service of attempted.reverse()) {
      try { await run(['bootout', domain, service.plistPath]); }
      catch (rollback) {
        let stillLoaded = false;
        try { await run(['print', `${domain}/${service.label}`]); stillLoaded = true; } catch { /* not loaded */ }
        if (stillLoaded) failures.push({ label: service.label, operation: 'unload_failed_build', code: rollback.code });
      }
    }
    for (const old of previous) {
      try {
        if (old.body) await atomicWriteFile(old.plistPath, old.body, 0o600);
        else await fs.rm(old.plistPath, { force: true });
      } catch (rollback) { failures.push({ label: old.label, operation: 'restore_file', code: rollback.code }); }
    }
    for (const old of previous.filter((entry) => entry.loaded)) {
      try { await run(['print', `${domain}/${old.label}`]); continue; } catch { /* reload */ }
      try { await run(['bootstrap', domain, old.plistPath]); }
      catch (rollback) { failures.push({ label: old.label, operation: 'reload_previous', code: rollback.code }); }
    }
    error.details = { rollback_restored: failures.length === 0, rollback_failures: failures };
    throw error;
  }
}
