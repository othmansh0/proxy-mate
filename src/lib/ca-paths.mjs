import { promises as fs } from 'node:fs';

// Shared validation for --ca-key/--ca-cert, used at install time and at daemon
// startup. Errors name the path, the errno and a fix so the cause reaches
// agents instead of a generic DAEMON_UNAVAILABLE.

async function inspect(filePath, stat) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return { kind: 'not_regular_file', errno: null };
    return null;
  } catch (error) {
    const kind = error?.code === 'ENOENT' ? 'missing'
      : ['EACCES', 'EPERM'].includes(error?.code) ? 'permission_denied' : 'unreadable';
    return { kind, errno: error?.code ?? null };
  }
}

export async function validateCustomCaPaths({ keyPath, certPath, stat = fs.stat } = {}) {
  if ((keyPath == null) !== (certPath == null)) {
    throw Object.assign(new Error('--ca-key and --ca-cert must be provided together.'), { code: 'CUSTOM_CA_INCOMPLETE', retryable: false });
  }
  if (keyPath == null) return null;
  const [key, cert] = await Promise.all([inspect(keyPath, stat), inspect(certPath, stat)]);
  if (!key && !cert) return { keyPath, certPath };
  const problems = [key && `key ${keyPath}: ${key.kind}${key.errno ? ` (${key.errno})` : ''}`,
    cert && `certificate ${certPath}: ${cert.kind}${cert.errno ? ` (${cert.errno})` : ''}`].filter(Boolean);
  const permission = [key, cert].some((item) => item?.kind === 'permission_denied');
  throw Object.assign(new Error(`Custom CA files are not usable: ${problems.join('; ')}.`), {
    code: 'CUSTOM_CA_UNREADABLE', retryable: false,
    details: { key_path: keyPath, cert_path: certPath, key_problem: key?.kind ?? null, key_errno: key?.errno ?? null,
      cert_problem: cert?.kind ?? null, cert_errno: cert?.errno ?? null },
    recovery: [
      ...(permission ? ['The background service cannot read files in macOS privacy-protected folders (Documents, Desktop, Downloads). Move the key and certificate under the proxy-mate state directory, or grant the Node binary Full Disk Access.'] : []),
      'Pass existing regular files to --ca-key and --ca-cert, or omit both to use the generated proxy-mate CA.',
    ],
  });
}
