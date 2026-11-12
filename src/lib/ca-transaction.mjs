import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWriteFile } from './state.mjs';

const journalName = 'rotation.pending.json';
async function syncDirectory(directory) {
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function durableWrite(file, value, mode) {
  await atomicWriteFile(file, value, mode);
  const handle = await fs.open(file, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(path.dirname(file));
}
function validate(pair) {
  try {
    const cert = new crypto.X509Certificate(pair.cert);
    if (!cert.ca || !cert.checkPrivateKey(crypto.createPrivateKey(pair.key))) throw new Error();
    if (Date.parse(cert.validFrom) > Date.now() || Date.parse(cert.validTo) <= Date.now()) throw new Error();
  } catch { throw Object.assign(new Error('Pending CA transaction is invalid; existing files were left untouched.'), { code: 'CA_TRANSACTION_INVALID' }); }
}

// Caller holds the CA interprocess lock. Persist the intended identity before
// replacing either public path; recovery completes that same identity, never
// generates a different key after an interrupted explicit rotation.
export async function commitCaPair(directory, pair) {
  validate(pair);
  await durableWrite(path.join(directory, journalName), JSON.stringify(pair), 0o600);
  await recoverCaPair(directory);
}
export async function recoverCaPair(directory) {
  const journal = path.join(directory, journalName);
  let raw;
  try {
    if ((await fs.stat(journal)).size > 1024 * 1024) throw new Error('Pending CA transaction is too large.');
    raw = await fs.readFile(journal, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  let pair;
  try { pair = JSON.parse(raw); } catch { throw Object.assign(new Error('Pending CA transaction is corrupt.'), { code: 'CA_TRANSACTION_INVALID' }); }
  validate(pair);
  await durableWrite(path.join(directory, 'key.pem'), pair.key, 0o600);
  await durableWrite(path.join(directory, 'cert.pem'), pair.cert, 0o644);
  await fs.unlink(journal);
  await syncDirectory(directory);
  return true;
}
