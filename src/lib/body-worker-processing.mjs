// Shared implementation: workers and synchronous fallback must redact identically.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { gunzip, inflate, brotliDecompress } from 'node:zlib';
import { storeFlowBody } from './bodies.mjs';
import { redactBody } from './redaction.mjs';
const BODY_DECODERS = { gzip: promisify(gunzip), 'x-gzip': promisify(gunzip), deflate: promisify(inflate), br: promisify(brotliDecompress) };

export async function processCapturedBody({ buffer, headers, flowId, kind, storeSensitiveData, captureBodyMode, redactionConfig, maxBodySize = 5 * 1024 * 1024 }) {
  let body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '');
  const wireSize = body.length;
  const encodings = String(headers?.['content-encoding'] ?? '').toLowerCase().split(',').map((s) => s.trim()).filter((s) => s && s !== 'identity');
  let decoded = false;
  let omission = !wireSize && (Number(headers?.['content-length']) > 0 || /chunked/i.test(String(headers?.['transfer-encoding'] ?? '')))
    ? 'body unavailable: nonempty length or chunked framing with no retained bytes; possibly exceeded capture limit' : null;
  if (wireSize && encodings.length && captureBodyMode !== 'metadata_only') {
    try {
      if (encodings.length > 4) throw new Error('Too many content encodings');
      for (const encoding of encodings.reverse()) {
        if (!Object.hasOwn(BODY_DECODERS, encoding)) throw new Error('Unsupported content encoding');
        body = await BODY_DECODERS[encoding](body, { maxOutputLength: maxBodySize });
      }
      decoded = true;
    } catch {
      omission = 'encoded body could not be decoded within the capture limit';
    }
  }
  if (omission) return {
    inline: null, path: null, size: wireSize, sha: null, encoding: 'binary',
    original_size: wireSize, redacted: false, omitted: omission, decoded: false,
  };
  const text = losslessUtf8(body);
  if (captureBodyMode === 'metadata_only') {
    return {
      inline: body.length === 0 ? '' : null,
      path: null,
      size: body.length,
      sha: null, // Metadata has no retained body to validate; hashes are optional in diff/export callers.
      encoding: text == null ? 'binary' : 'utf8',
      original_size: body.length,
      redacted: false,
      omitted: body.length ? 'body omitted by metadata_only capture policy' : null,
    };
  }
  if (storeSensitiveData && captureBodyMode === 'all' || body.length === 0) {
    return {
      ...await storeFlowBody(body, flowId, kind, { text }),
      decoded,
      original_size: body.length,
      redacted: false,
      omitted: null,
    };
  }

  if (text == null) {
    return {
      inline: null,
      path: null,
      size: body.length,
      sha: crypto.createHash('sha256').update(body).digest('hex'),
      encoding: 'binary',
      original_size: body.length,
      redacted: false,
      omitted: 'binary body omitted because sensitive storage is disabled',
    };
  }
  const safeText = redactBody(text, headers, [], redactionConfig);
  const stored = await storeFlowBody(Buffer.from(safeText, 'utf8'), flowId, kind, { text: safeText });
  return {
    ...stored,
    decoded,
    original_size: body.length,
    redacted: safeText !== text,
    omitted: null,
  };
}

function losslessUtf8(buffer) {
  try {
    const text = buffer.toString('utf8');
    return Buffer.byteLength(text, 'utf8') === buffer.length ? text : null;
  } catch { return null; }
}
