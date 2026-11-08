import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import { listSimulators } from './sim.mjs';

const execute = promisify(execFile);

async function appContext(udid) {
  const listed = await listSimulators({ scope: 'booted', device_ids: [udid] });
  const device = listed.simulators.find((item) => item.udid === udid);
  if (!listed.preflight.ok || !device) throw Object.assign(new Error('Boot the selected Simulator before choosing an app.'), {
    code: 'SIMULATOR_NOT_BOOTED', recovery: ['Boot the selected Simulator and retry.'],
  });
  return { device, developerDir: listed.preflight.developer_dir };
}

function parsePlist(value) {
  try { return Promise.resolve(JSON.parse(value)); } catch {}
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'],
      { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        if (error) reject(error);
        else { try { resolve(JSON.parse(stdout)); } catch (failure) { reject(failure); } }
      });
    child.stdin.on('error', () => {});
    child.stdin.end(value);
  });
}

export async function listSimulatorApplications({ udid }) {
  const { device, developerDir } = await appContext(udid);
  const { stdout } = await execute('/usr/bin/xcrun', ['simctl', 'listapps', udid], {
    env: { ...process.env, DEVELOPER_DIR: developerDir }, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  });
  const apps = await parsePlist(stdout);
  return { device, applications: Object.entries(apps).map(([bundle_id, app]) => ({
    bundle_id, name: app.CFBundleDisplayName ?? app.CFBundleName ?? bundle_id, kind: app.ApplicationType ?? 'Unknown',
  })).sort((a, b) => a.name.localeCompare(b.name)) };
}

export async function resolveSimulatorApplication({ udid, bundle_id }) {
  const { device, developerDir } = await appContext(udid);
  const { stdout } = await execute('/usr/bin/xcrun', ['simctl', 'get_app_container', udid, bundle_id, 'app'], {
    env: { ...process.env, DEVELOPER_DIR: developerDir }, timeout: 15_000, maxBuffer: 64 * 1024,
  });
  const appPath = await fs.realpath(stdout.trim());
  if (!appPath.endsWith('.app')) throw Object.assign(new Error('The selected application bundle could not be identified.'), { code: 'APP_NOT_FOUND' });
  return { device, developerDir, appPath, bundle_id };
}

export function simulatorProcessVerifier({ device, bundle_id, developerDir }) {
  return async (pid) => {
    const { stdout } = await execute('/usr/bin/xcrun', ['simctl', 'spawn', device.udid, 'launchctl', 'list'], {
      env: { ...process.env, DEVELOPER_DIR: developerDir }, timeout: 2000, maxBuffer: 1024 * 1024,
    });
    return stdout.split('\n').some((line) => {
      const fields = line.trim().split(/\s+/);
      const label = fields[2]?.split('[')[0];
      return Number(fields[0]) === pid && label === `UIKitApplication:${bundle_id}`;
    });
  };
}
