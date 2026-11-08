export function encodeAgentJson(value) {
  let text;
  try { text = JSON.stringify(value); } catch { /* input error below */ }
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024) {
    throw Object.assign(new Error('Provide a JSON value no larger than 1 MiB.'), { code: 'INVALID_JSON_BODY' });
  }
  return text;
}

// RFC 7396: null deletes object members, arrays replace. Prototype-shaped keys
// remain inert JSON data, never assignments to an object's prototype.
export function mergeJsonPatch(target, patch, depth = 0) {
  if (depth > 50) throw Object.assign(new Error('JSON patch nesting exceeds 50 levels.'), { code: 'JSON_PATCH_TOO_DEEP' });
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const result = Object.assign(Object.create(null), target && typeof target === 'object' && !Array.isArray(target) ? target : {});
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = mergeJsonPatch(Object.hasOwn(result, key) ? result[key] : undefined, value, depth + 1);
  }
  return result;
}
