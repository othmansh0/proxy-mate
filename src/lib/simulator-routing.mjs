import { trustCaOnSimulators } from './sim.mjs';
import { verifySimulatorCertificate } from './simulator-probe.mjs';

export async function setupSimulatorRouting({
  certPath,
  keyPath,
  applyRouting,
  trust = trustCaOnSimulators,
  verify = verifySimulatorCertificate,
}) {
  if (typeof applyRouting !== 'function') throw new TypeError('applyRouting is required.');
  const report = await trust(certPath);
  if (!report.ok) {
    throw Object.assign(new Error('Simulator certificate setup failed; routing was not enabled.'), {
      code: 'SIMULATOR_CA_SETUP_FAILED',
      details: report,
      recovery: ['Resolve setup_simulator_certificate failures before enabling routing.'],
    });
  }
  if (!report.trusted?.length) {
    throw Object.assign(new Error('Boot the target Simulator before enabling automatic routing.'), {
      code: 'SIMULATOR_NOT_BOOTED',
      recovery: ['Boot the target Simulator and retry automatic setup.',
        'For capture without a Simulator, configure routing explicitly without automatic Simulator setup.'],
    });
  }
  const verifications = [];
  for (const simulator of report.trusted) {
    let result;
    try {
      result = await verify({
        udid: simulator.udid,
        keyPath,
        certPath,
        developer_dir: report.preflight?.developer_dir,
      });
    } catch (error) {
      result = { ok: false, system_tls_verified: false, error: error?.message ?? String(error) };
    }
    if (!result.ok || !result.system_tls_verified) {
      throw Object.assign(new Error(`Native TLS trust could not be verified on Simulator ${simulator.udid}; routing was not enabled.`), {
        code: 'SIMULATOR_TLS_VERIFICATION_FAILED',
        details: { device_id: simulator.udid, verification: result },
        recovery: ['Run verify_simulator_certificate for this device and resolve its failure before enabling routing.'],
      });
    }
    verifications.push(result);
  }
  const verified = new Set(report.trusted.map((simulator) => simulator.udid));
  const markVerified = (simulator) => verified.has(simulator.udid)
    ? {
      ...simulator,
      system_tls_verified: true,
      manual_trust_may_be_required: false,
      verification_note: 'Native URLSession TLS trust verified before enabling routing. Automatic app routing and certificate pinning are separate checks.',
    }
    : simulator;
  const trustReport = {
    ...report,
    trusted: report.trusted.map(markVerified),
    results: report.results?.map(markVerified),
    verifications,
  };
  const routing = await applyRouting();
  return { trust: trustReport, routing };
}
