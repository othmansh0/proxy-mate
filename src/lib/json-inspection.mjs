const MAX_SCAN_NODES = 100_000;
const MAX_OUTPUT_BYTES = 12_000;

// JSON Pointer plus a single-segment wildcard. This is a bounded data query,
// never JavaScript, JSONPath evaluation, a regex or a command execution path.
export function inspectJson(document, { pointers, distinct = true, max_results = 20 } = {}) {
  if (!Array.isArray(pointers) || !pointers.length || pointers.length > 10
    || !Number.isInteger(max_results) || max_results < 1 || max_results > 50) throw invalidPointer();
  let scanned = 0, remaining = MAX_OUTPUT_BYTES;
  const results = pointers.map((pointer) => {
    if (typeof pointer !== 'string' || pointer.length > 256 || pointer && !pointer.startsWith('/') || /~(?![01])/u.test(pointer)) throw invalidPointer();
    const segments = pointer ? pointer.slice(1).split('/').map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~')) : [];
    const pending = [{ value: document, index: 0, path: '' }];
    const values = [], unique = new Map();
    let matched = 0, omitted = 0;
    while (pending.length && scanned < MAX_SCAN_NODES) {
      const current = pending.pop();
      scanned += 1;
      if (current.index === segments.length) {
        matched += 1;
        const value = summarizeValue(current.value);
        const summarized = current.value !== null && typeof current.value === 'object'
          || typeof current.value === 'string' && current.value.length > 512;
        const key = summarized ? Symbol() : JSON.stringify(value);
        if (distinct && unique.has(key)) { unique.get(key).count += 1; continue; }
        const entry = { value, count: 1, example_pointer: current.path };
        const bytes = Buffer.byteLength(JSON.stringify(entry));
        if (values.length >= max_results || bytes > remaining) { omitted += 1; continue; }
        remaining -= bytes;
        values.push(entry);
        if (distinct) unique.set(key, entry);
        continue;
      }
      if (!current.value || typeof current.value !== 'object') continue;
      const segment = segments[current.index];
      const keys = segment === '*' ? Object.keys(current.value) : Object.hasOwn(current.value, segment) ? [segment] : [];
      // Bound the work queue as well as visited nodes for very broad arrays.
      const available = Math.max(0, MAX_SCAN_NODES - scanned - pending.length);
      const chosen = keys.slice(0, available);
      if (chosen.length < keys.length) omitted += keys.length - chosen.length;
      for (let index = chosen.length - 1; index >= 0; index--) {
        const key = chosen[index];
        pending.push({ value: current.value[key], index: current.index + 1,
          path: `${current.path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}` });
      }
    }
    return { pointer, matched_count: matched, values, truncated: omitted > 0 || pending.length > 0,
      match_count_complete: omitted === 0 && pending.length === 0 };
  });
  return { results, scanned_nodes: scanned, scan_limit: MAX_SCAN_NODES,
    next_actions: results.some((result) => result.truncated)
      ? ['Narrow the pointer or save_body_to_file for offline analysis; do not infer absence from a truncated query.'] : [] };
}

function summarizeValue(value) {
  if (typeof value === 'string' && value.length > 512) return { type: 'string', length: value.length, preview: value.slice(0, 512), truncated: true };
  if (Array.isArray(value)) return { type: 'array', length: value.length };
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    return { type: 'object', keys: keys.slice(0, 12), key_count: keys.length };
  }
  return value;
}

function invalidPointer() {
  return Object.assign(new Error('Use 1–10 JSON Pointers (empty for root, / for fields, * for one array/object segment), each at most 256 characters.'), {
    code: 'INVALID_JSON_POINTER', recovery: ['Example: pointers=["/data/itineraries/*/vendor"], distinct=true.'],
  });
}
