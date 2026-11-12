import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const options = { timeout: 5000, maxBuffer: 1024 * 1024 };

export function readScutil(input) {
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/sbin/scutil', [], options, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export async function detectPrimaryNetworkService({ query = readScutil } = {}) {
  const global = await query('show State:/Network/Global/IPv4\nshow State:/Network/Global/IPv6\nquit\n');
  const ids = [...new Set([...global.matchAll(/PrimaryService\s*:\s*([A-Fa-f0-9-]{36})/g)].map((m) => m[1]))];
  for (const id of ids) {
    const setup = await query(`show Setup:/Network/Service/${id}\nquit\n`);
    const name = setup.match(/^\s*UserDefinedName\s*:\s*(.+)$/m)?.[1]?.trim();
    if (name) return name;
  }
  return null;
}

export async function selectNetworkService(preferred, {
  run = exec, primary = detectPrimaryNetworkService,
} = {}) {
  const { stdout } = await run('/usr/sbin/networksetup', ['-listallnetworkservices'], options);
  const services = stdout.split('\n').slice(1).map((s) => s.trim()).filter((s) => s && !s.startsWith('*'));
  if (preferred) {
    if (services.includes(preferred)) return preferred;
    throw Object.assign(new Error(`Network service is missing or disabled: ${preferred}`), { code: 'NETWORK_SERVICE_UNAVAILABLE' });
  }
  const selected = await primary().catch(() => null);
  if (selected && services.includes(selected)) return selected;
  throw Object.assign(new Error('Could not identify an active macOS network service. Specify network_service explicitly; no settings were changed.'), {
    code: 'NETWORK_SERVICE_UNDETERMINED', details: { enabled_services: services },
  });
}
