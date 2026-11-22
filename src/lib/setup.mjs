import { validateRoutingDomains } from './pac.mjs';

export const CAPTURE_SETUP_QUESTIONS = [
  'Which simulator and app would you like to track?',
  'Would you like app-only capture, selected API domains, or broader Mac capture? App-only is the default.',
  'How long should capture routing stay enabled?',
];

export function parseApiDomains(input) {
  const domains = String(input).split(/[\s,]+/).filter(Boolean).map((value) => {
    if (!value.includes('://')) return value.toLowerCase();
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Enter HTTP API URLs without embedded credentials.');
    return url.hostname.toLowerCase();
  });
  const unique = [...new Set(domains)];
  validateRoutingDomains(unique);
  if (unique.some((host) => ['localhost', '127.0.0.1', '[::1]'].includes(host))) {
    throw new Error('Local APIs need a scoped reverse proxy; ask the agent to use create_reverse_proxy.');
  }
  return unique;
}

async function choose(ask, write, title, choices, defaultIndex = 0) {
  if (!choices.length) throw new Error('No available choices. Boot a Simulator and install the app, then retry.');
  write(title + '\n' + choices.map((choice, index) => `  ${index + 1}) ${choice.label}`).join('\n') + '\n');
  for (;;) {
    const answer = (await ask(`Choose [${defaultIndex + 1}] (or q to cancel): `)).trim();
    if (/^(q|quit|cancel)$/i.test(answer)) return null;
    const index = answer === '' ? defaultIndex : Number(answer) - 1;
    if (Number.isInteger(index) && choices[index]) return choices[index].value;
    write('Choose one of the numbers shown.\n');
  }
}

export async function runCaptureSetup({ ask, write, call }) {
  write('ProxyFan setup\nApp-only capture is the default. Broader capture requires your selection.\n');
  const scope = await choose(ask, write, 'What would you like to capture?', [
    { label: 'One simulator app (recommended)', value: 'app' },
    { label: 'Selected API domains across apps', value: 'domains' },
    { label: 'All Mac traffic (advanced)', value: 'mac' },
  ]);
  if (!scope) return { status: 'cancelled' };
  const targets = await call('list_simulator_apps', {});
  const devices = (targets.devices ?? []).map((device) => ({ label: `${device.name} (${device.udid})`, value: device }));
  if (scope !== 'app') devices.unshift({ label: 'Mac only', value: { udid: null, name: 'Mac' } });
  const device = await choose(ask, write, 'Which device would you like to use?', devices);
  if (!device) return { status: 'cancelled' };
  let app = null;
  let domains = [];
  if (scope === 'app') {
    const listed = await call('list_simulator_apps', { udid: device.udid });
    app = await choose(ask, write, 'Which app would you like to track?', listed.applications.map((entry) => ({
      label: `${entry.name} — ${entry.bundle_id}`, value: entry,
    })));
    if (!app) return { status: 'cancelled' };
  } else if (scope === 'domains') {
    for (;;) {
      const answer = await ask('What APIs do you want to track? Enter URLs or domains, separated by commas (q to cancel): ');
      if (/^(q|quit|cancel)$/i.test(answer.trim())) return { status: 'cancelled' };
      try { domains = parseApiDomains(answer); break; }
      catch (error) { write(error.message + '\n'); }
    }
  } else domains = ['*'];
  let minutes;
  for (;;) {
    const answer = (await ask('How many minutes should routing stay on? [60] (q to cancel): ')).trim();
    if (/^(q|quit|cancel)$/i.test(answer)) return { status: 'cancelled' };
    minutes = answer === '' ? 60 : Number(answer);
    if (Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440) break;
    write('Choose a whole number from 1 to 1440 minutes.\n');
  }
  write(`\nCapture: ${app ? app.name + ' (' + app.bundle_id + ')' : domains.join(', ')}\nDevice: ${device.name}\nRouting duration: ${minutes} minutes\n`);
  write(scope === 'app'
    ? 'Only identified app connections will be inspected. Mac Keychain trust is not requested. The local gateway forwards other and unidentified connections without capture; background helpers may not be attributable. Mac proxy routing will change for this session.\n'
    : 'This mode can inspect matching traffic from other apps and requires Mac certificate trust. The native explanation will appear before new trust is requested.\n');
  write('Starting replaces any current ProxyFan capture. Other proxy settings are preserved.\n');
  if (!/^(y|yes)$/i.test((await ask('Start capture? [y/N]: ')).trim())) return { status: 'cancelled' };
  const status = await call('get_proxy_status', {});
  const port = status.port ?? 8080;
  if (status.running) await call('stop_proxy', {});
  try {
    let result;
    if (scope === 'app') {
      result = await call('start_app_capture', { udid: device.udid, bundle_id: app.bundle_id,
        duration_seconds: minutes * 60 });
    } else {
      await call('start_proxy', { port, auto_setup: false });
      if (device.udid) {
        const trust = await call('setup_simulator_certificate', { device_ids: [device.udid], restart_apps: false });
        if (!trust.ok) throw new Error('Simulator certificate setup failed.');
        const verified = await call('verify_simulator_certificate', { udid: device.udid });
        if (!verified.system_tls_verified) throw new Error('Simulator TLS verification failed.');
      }
      const host = await call('setup_host_certificate', {});
      if (!host.trusted) throw new Error(host.error ?? 'Mac certificate trust was not approved.');
      result = await call('set_proxy_routing', { domains, allow_broad_routing: scope === 'mac', duration_seconds: minutes * 60 });
      if (device.udid) write('Relaunch the app you want to test so it uses the new proxy routing.\n');
    }
    write('Capture is ready. Run the app action, then ask your agent to inspect its requests.\n');
    return result;
  } catch (error) {
    await call('stop_proxy', {}).catch(() => {});
    throw error;
  }
}
