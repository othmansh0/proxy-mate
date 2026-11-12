import { promises as fs } from 'node:fs';
import { authorizeReadPath } from './paths.mjs';
import { redactBody } from './redaction.mjs';

export const MAX_EXPORTED_BODY_BYTES = 50 * 1024 * 1024;

// Shared by file/HAR/session exports so spilling a textual body to disk does
// not silently turn it into binary data or require access to credentials.
export async function bodyForExport(part, { includeSensitive = false, maxBytes = MAX_EXPORTED_BODY_BYTES } = {}) {
  const omitted = (reason) => ({ omitted: true, reason, bytes: 0 });
  if (!part) return omitted('body part is unavailable');
  if (part.body_omitted) return omitted(String(part.body_omission_reason ?? part.body_omitted));
  let bytes;
  try {
    if (part.body_path) {
      const source = await authorizeReadPath(part.body_path);
      const handle = await fs.open(source, 'r');
      try {
        if ((await handle.stat()).size > maxBytes) return omitted('body exceeds the export byte limit');
        bytes = await handle.readFile();
      } finally { await handle.close(); }
    } else if (part.body_base64 != null) {
      if (part.body_base64.length > Math.ceil(maxBytes / 3) * 4) return omitted('body exceeds the export byte limit');
      bytes = Buffer.from(part.body_base64, 'base64');
    } else if (part.body_inline != null) {
      if (Buffer.byteLength(part.body_inline) > maxBytes) return omitted('body exceeds the export byte limit');
      bytes = Buffer.from(part.body_inline);
    } else if (!part.body_size) {
      bytes = Buffer.alloc(0);
    } else return omitted('captured body bytes are unavailable');
  } catch (error) {
    if (error.code === 'PATH_NOT_AUTHORIZED') throw error;
    if (!['ENOENT', 'PATH_NOT_FOUND'].includes(error.code)) throw error;
    return omitted('captured body file is no longer available');
  }
  if (bytes.length > maxBytes) return omitted('body exceeds the export byte limit');
  const text = bytes.toString('utf8');
  if (includeSensitive) return { omitted: false, buffer: bytes, bytes: bytes.length,
    ...(part.body_encoding !== 'binary' && Buffer.from(text).equals(bytes) ? { text } : {}) };
  if (part.body_encoding === 'binary' || !Buffer.from(text).equals(bytes) || text.includes('\0')) {
    return omitted('binary bodies require include_sensitive=true and the server-level sensitive-data grant');
  }
  const redacted = redactBody(text, part.headers);
  const buffer = Buffer.from(redacted);
  if (buffer.length > maxBytes) return omitted('redacted body exceeds the export byte limit');
  return { omitted: false, buffer, text: redacted, bytes: buffer.length };
}
