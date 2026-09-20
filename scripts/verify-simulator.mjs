import { ensureCA } from '../src/lib/proxy.mjs';
import { setupSimulatorCertificates } from '../src/lib/sim.mjs';
import { verifySimulatorCertificate } from '../src/lib/simulator-probe.mjs';

const args = process.argv.slice(2);
const udid = args.find((value) => !value.startsWith('--'));
if (!udid || args.some((value) => value.startsWith('--') && value !== '--install')) {
  console.error('Usage: node scripts/verify-simulator.mjs DEVICE_UDID [--install]');
  process.exitCode = 2;
} else {
  const ca = await ensureCA();
  if (args.includes('--install')) {
    const setup = await setupSimulatorCertificates({ cert_path: ca.certPath, device_ids: [udid] });
    if (!setup.ok) throw new Error(JSON.stringify(setup));
  }
  const result = await verifySimulatorCertificate({ ...ca, udid });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
