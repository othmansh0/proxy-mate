// Small, dependency-free OpenAPI 3.x contract checker for captured flows.
// It deliberately validates only a predictable subset of JSON Schema. Callers
// must treat `unsupported` as part of the result rather than assuming full
// OpenAPI/JSON Schema validation.

export const MAX_OPENAPI_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const MAX_OPENAPI_BODY_BYTES = 4 * 1024 * 1024;
export const DEFAULT_OPENAPI_FLOW_BATCH_LIMIT = 100;
export const MAX_OPENAPI_FLOW_BATCH_LIMIT = 1_000;

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const COMPLEX_SCHEMA_KEYWORDS = [
  '$ref', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'contains',
  'patternProperties', 'unevaluatedProperties', 'dependentRequired',
];

/**
 * Accept an already parsed JSON OpenAPI document, or a JSON string. YAML is
 * intentionally not parsed: accepting YAML without a parser would be unsafe
 * and misleading. The returned document is safe to pass to validateOpenApiFlow.
 */
export function loadOpenApiDocument(input, { maxBytes = MAX_OPENAPI_DOCUMENT_BYTES, externalDocuments = {} } = {}) {
  const errors = [];
  let document = input;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) maxBytes = MAX_OPENAPI_DOCUMENT_BYTES;

  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > maxBytes) {
      return loadFailure('OPENAPI_DOCUMENT_TOO_LARGE', `OpenAPI document exceeds ${maxBytes} bytes.`);
    }
    try { document = JSON.parse(input); }
    catch {
      return loadFailure('OPENAPI_JSON_REQUIRED', 'OpenAPI input must be parsed JSON or a JSON document. YAML is not supported without a parser.');
    }
  } else {
    let serialized;
    try { serialized = JSON.stringify(input); }
    catch { return loadFailure('OPENAPI_DOCUMENT_NOT_JSON', 'OpenAPI document must be JSON-serializable.'); }
    if (!serialized || Buffer.byteLength(serialized, 'utf8') > maxBytes) {
      return loadFailure('OPENAPI_DOCUMENT_TOO_LARGE', `OpenAPI document exceeds ${maxBytes} bytes.`);
    }
  }

  if (!isObject(document) || Array.isArray(document)) errors.push(issue('OPENAPI_DOCUMENT_INVALID', 'document', 'OpenAPI document must be a JSON object.'));
  if (typeof document?.openapi !== 'string' || !/^3\.\d+\.\d+(?:[-+].*)?$/.test(document.openapi)) {
    errors.push(issue('OPENAPI_VERSION_UNSUPPORTED', 'document.openapi', 'Only OpenAPI 3.x documents are supported.', { actual: document?.openapi ?? null }));
  }
  if (!isObject(document?.paths)) errors.push(issue('OPENAPI_PATHS_INVALID', 'document.paths', 'OpenAPI document must contain a paths object.'));

  if (errors.length > 0) return { ok: false, document: null, errors, warnings: [], unsupported: [] };
  const resolved = resolveOpenApiReferences(document, { externalDocuments });
  return { ok: resolved.errors.length === 0, document: resolved.errors.length === 0 ? resolved.document : null, errors: resolved.errors, warnings: resolved.warnings, unsupported: [] };
}

/** Resolve local and caller-provided JSON documents. Remote URLs are never fetched. */
export function resolveOpenApiReferences(document, { externalDocuments = {} } = {}) {
  const errors = []; const warnings = [];
  const root = cloneJson(document); const externals = new Map();
  for (const [key, value] of Object.entries(isObject(externalDocuments) ? externalDocuments : {})) {
    try { externals.set(key, typeof value === 'string' ? JSON.parse(value) : cloneJson(value)); }
    catch { errors.push(issue('OPENAPI_EXTERNAL_DOCUMENT_INVALID', `externalDocuments.${key}`, 'External OpenAPI reference document must be JSON.')); }
  }
  const resolving = new Set();
  function resolve(value, base, trail = '') {
    if (Array.isArray(value)) return value.map((item, index) => resolve(item, base, `${trail}/${index}`));
    if (!isObject(value)) return value;
    if (typeof value.$ref === 'string') {
      const reference = value.$ref; const [file, fragment = ''] = reference.split('#', 2);
      let source = base;
      if (file) {
        source = externals.get(file);
        if (!source) { errors.push(issue('OPENAPI_REFERENCE_UNRESOLVED', trail || 'document', `Reference ${reference} is not available. Provide it via externalDocuments; remote fetching is disabled.`, { ref: reference })); return value; }
      }
      const key = `${file || '__root__'}#${fragment}`;
      if (resolving.has(key)) { warnings.push('OPENAPI_CIRCULAR_REFERENCE'); return value; }
      const target = pointer(source, fragment);
      if (target === undefined) { errors.push(issue('OPENAPI_REFERENCE_UNRESOLVED', trail || 'document', `Reference ${reference} does not exist.`, { ref: reference })); return value; }
      resolving.add(key); const resolved = resolve(cloneJson(target), source, trail); resolving.delete(key);
      return resolve({ ...resolved, ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== '$ref')) }, base, trail);
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolve(child, base, `${trail}/${key}`)]));
  }
  return { document: resolve(root, root), errors, warnings: [...new Set(warnings)] };
}

/**
 * Validate one proxy-mcp captured flow against a loaded OpenAPI 3.x document.
 * Supported schemas: object/properties/required, array/items, primitive type,
 * enum and nullable. `$ref`, composition and advanced JSON Schema are reported
 * in `unsupported`, never silently treated as fully validated.
 */
export function validateOpenApiFlow(documentInput, flow, options = {}) {
  const loaded = loadOpenApiDocument(documentInput, options);
  const maxBodyBytes = normalizeLimit(options.maxBodyBytes, MAX_OPENAPI_BODY_BYTES);
  const result = resultShape();
  if (!loaded.ok) {
    result.errors.push(...loaded.errors);
    return finish(result);
  }
  result.warnings.push(...loaded.warnings);

  const request = isObject(flow?.request) ? flow.request : (isObject(flow) ? flow : null);
  const response = isObject(flow?.response) ? flow.response : null;
  if (!request) {
    result.errors.push(issue('FLOW_REQUEST_MISSING', 'flow.request', 'Flow does not contain a request.'));
    return finish(result);
  }

  const requestUrl = parseRequestUrl(request);
  if (!requestUrl) {
    result.errors.push(issue('FLOW_URL_INVALID', 'flow.request.url', 'Captured request URL must be an absolute HTTP URL.'));
    return finish(result);
  }
  const method = String(request.method ?? 'GET').toLowerCase();
  result.method = method.toUpperCase();
  const match = matchPath(loaded.document.paths, requestUrl.pathname);
  if (!match) {
    result.errors.push(issue('OPENAPI_PATH_NOT_FOUND', 'request.path', `No OpenAPI path matches ${requestUrl.pathname}.`, { actual: requestUrl.pathname }));
    return finish(result);
  }
  result.path_template = match.template;
  const operation = match.pathItem[method];
  if (!isObject(operation)) {
    result.errors.push(issue('OPENAPI_METHOD_NOT_FOUND', 'request.method', `No ${method.toUpperCase()} operation is declared for ${match.template}.`, { actual: method.toUpperCase() }));
    return finish(result);
  }
  result.operation_id = typeof operation.operationId === 'string' ? operation.operationId : null;
  if (!result.operation_id) result.warnings.push('OPENAPI_OPERATION_ID_MISSING');

  validateParameters(mergeParameters(match.pathItem.parameters, operation.parameters), requestUrl, request, match.params, result);
  validateRequestBody(operation.requestBody, request, result, maxBodyBytes);
  validateResponse(operation.responses, response, result, maxBodyBytes);
  return finish(result);
}

/**
 * Validate a bounded capture session. Successful flows are summarized in
 * counters only; failures deliberately omit request/response bodies.
 */
export function validateOpenApiFlows(documentInput, flows, options = {}) {
  const input = Array.isArray(flows) ? flows : [];
  const limit = normalizeBatchLimit(options.maxFlows);
  const selected = input.slice(0, limit);
  const loaded = loadOpenApiDocument(documentInput, options);
  const counts = { valid: 0, invalid: 0, unmatched: 0, unsupported: 0 };
  const failures = [];
  for (let index = 0; index < selected.length; index += 1) {
    // Passing the resolved document keeps all flows on the same contract while
    // preserving the public single-flow validator as the source of truth.
    const result = loaded.ok
      ? validateOpenApiFlow(loaded.document, selected[index], options)
      : validateOpenApiFlow(documentInput, selected[index], options);
    if (result.valid) counts.valid += 1;
    else {
      counts.invalid += 1;
      failures.push(compactFlowFailure(index, result));
    }
    if (!result.matched) counts.unmatched += 1;
    if (result.unsupported.length > 0) counts.unsupported += 1;
  }
  return {
    valid: counts.invalid === 0 && input.length <= limit,
    processed: selected.length,
    total: input.length,
    truncated: input.length > selected.length,
    skipped_count: Math.max(0, input.length - selected.length),
    limit,
    counts,
    failures,
  };
}

function compactFlowFailure(index, result) {
  return {
    index, matched: result.matched, operation_id: result.operation_id,
    path_template: result.path_template, method: result.method,
    errors: result.errors.map(({ code, location, message }) => ({ code, location, message })),
    unsupported: [...result.unsupported], warnings: [...result.warnings],
  };
}

function resultShape() {
  return {
    valid: false, matched: false, operation_id: null, path_template: null, method: null,
    errors: [], warnings: [], unsupported: [], request: { valid: true }, response: { present: false, valid: true },
  };
}

function finish(result) {
  result.matched = result.path_template !== null;
  result.valid = result.errors.length === 0;
  result.unsupported = [...new Set(result.unsupported)];
  result.warnings = [...new Set(result.warnings)];
  result.request.valid = !result.errors.some((entry) => entry.location.startsWith('request'));
  result.response.valid = !result.errors.some((entry) => entry.location.startsWith('response'));
  return result;
}

function loadFailure(code, message) {
  return { ok: false, document: null, errors: [issue(code, 'document', message)], warnings: [], unsupported: [] };
}

function matchPath(paths, pathname) {
  const exact = Object.entries(paths).find(([template, item]) => template === pathname && isObject(item));
  if (exact) return { template: exact[0], pathItem: exact[1], params: {} };
  for (const [template, pathItem] of Object.entries(paths)) {
    if (!isObject(pathItem) || !template.includes('{')) continue;
    const names = [];
    const escaped = template.split(/(\{[^}]+\})/g).map((part) => {
      if (/^\{[^}]+\}$/.test(part)) { names.push(part.slice(1, -1)); return '([^/?#]+)'; }
      return escapeRegex(part);
    }).join('');
    const found = new RegExp(`^${escaped}$`).exec(pathname);
    if (found) return { template, pathItem, params: Object.fromEntries(names.map((name, index) => [name, safeDecode(found[index + 1])])) };
  }
  return null;
}

function mergeParameters(pathParameters, operationParameters) {
  const out = new Map();
  for (const parameter of [...asArray(pathParameters), ...asArray(operationParameters)]) {
    if (!isObject(parameter)) continue;
    if (parameter.$ref) continue;
    if (typeof parameter.name !== 'string' || typeof parameter.in !== 'string') continue;
    out.set(`${parameter.in}:${parameter.name.toLowerCase()}`, parameter);
  }
  return [...out.values()];
}

function validateParameters(parameters, url, request, pathParams, result) {
  const headers = headersOf(request.headers);
  for (const parameter of parameters) {
    if (parameter.$ref) { unsupported(result, 'OPENAPI_PARAMETER_REFERENCE_UNSUPPORTED'); continue; }
    const location = parameter.in;
    let value;
    if (location === 'path') value = pathParams[parameter.name];
    else if (location === 'query') value = url.searchParams.get(parameter.name);
    else if (location === 'header') value = headers.get(parameter.name.toLowerCase());
    else { unsupported(result, `OPENAPI_PARAMETER_LOCATION_UNSUPPORTED:${location}`); continue; }
    if (parameter.required === true && (value === undefined || value === null || value === '')) {
      result.errors.push(issue('OPENAPI_REQUIRED_PARAMETER_MISSING', `request.${location}.${parameter.name}`, `Required ${location} parameter ${parameter.name} is missing.`, { parameter: parameter.name, in: location }));
    }
  }
}

function validateRequestBody(requestBody, request, result, maxBodyBytes) {
  if (!isObject(requestBody)) return;
  if (requestBody.$ref) { unsupported(result, 'OPENAPI_REQUEST_BODY_REFERENCE_UNSUPPORTED'); return; }
  const body = bodyValue(request, maxBodyBytes);
  if (body.missing) {
    if (requestBody.required === true) result.errors.push(issue('OPENAPI_REQUIRED_REQUEST_BODY_MISSING', 'request.body', 'Operation requires a request body.'));
    return;
  }
  validateContent(requestBody.content, request, body, 'request', result);
}

function validateResponse(responses, response, result, maxBodyBytes) {
  if (!isObject(response)) { result.warnings.push('FLOW_RESPONSE_MISSING'); return; }
  result.response.present = true;
  if (!isObject(responses)) { result.warnings.push('OPENAPI_RESPONSES_UNSPECIFIED'); return; }
  const status = Number(response.statusCode ?? response.status ?? response.status_code);
  if (!Number.isInteger(status)) { result.errors.push(issue('FLOW_RESPONSE_STATUS_MISSING', 'response.status', 'Flow response has no integer status code.')); return; }
  const definition = responses[String(status)] ?? responses[`${String(status)[0]}XX`] ?? responses.default;
  if (!isObject(definition)) {
    result.errors.push(issue('OPENAPI_RESPONSE_STATUS_UNDECLARED', 'response.status', `Response status ${status} is not declared by this operation.`, { actual: status }));
    return;
  }
  if (definition.$ref) { unsupported(result, 'OPENAPI_RESPONSE_REFERENCE_UNSUPPORTED'); return; }
  const body = bodyValue(response, maxBodyBytes);
  if (!body.missing) validateContent(definition.content, response, body, 'response', result);
}

function validateContent(content, part, body, prefix, result) {
  if (!isObject(content) || Object.keys(content).length === 0) return;
  const actual = mediaType(headersOf(part.headers).get('content-type'));
  if (!actual) {
    result.errors.push(issue(`OPENAPI_${prefix.toUpperCase()}_CONTENT_TYPE_MISSING`, `${prefix}.headers.content-type`, `${prefix} body is present but Content-Type is missing.`));
    return;
  }
  const selected = selectMediaType(content, actual);
  if (!selected) {
    result.errors.push(issue(`OPENAPI_${prefix.toUpperCase()}_CONTENT_TYPE_UNDECLARED`, `${prefix}.headers.content-type`, `${prefix} Content-Type ${actual} is not declared.`, { actual, expected: Object.keys(content) }));
    return;
  }
  const schema = selected.schema;
  if (!isObject(schema)) return;
  if (!isJsonMediaType(actual)) { result.warnings.push(`OPENAPI_${prefix.toUpperCase()}_SCHEMA_SKIPPED_NON_JSON`); return; }
  if (body.tooLarge) { result.warnings.push(`OPENAPI_${prefix.toUpperCase()}_BODY_TOO_LARGE_FOR_SCHEMA`); return; }
  let value;
  try { value = typeof body.value === 'string' ? JSON.parse(body.value) : JSON.parse(Buffer.from(body.value).toString('utf8')); }
  catch {
    result.errors.push(issue(`OPENAPI_${prefix.toUpperCase()}_JSON_INVALID`, `${prefix}.body`, `${prefix} Content-Type is JSON but body is not valid JSON.`));
    return;
  }
  validateSimpleSchema(schema, value, `${prefix}.body`, result);
}

function validateSimpleSchema(schema, value, location, result) {
  if (!isObject(schema)) return;
  for (const keyword of COMPLEX_SCHEMA_KEYWORDS) if (keyword in schema) unsupported(result, `OPENAPI_SCHEMA_${keyword.replace('$', 'REF_').toUpperCase()}_UNSUPPORTED`);
  if (schema.$ref) return;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type].filter(Boolean);
  if (types.length > 0 && !types.some((type) => typeMatches(value, type, schema.nullable === true))) {
    result.errors.push(issue('OPENAPI_SCHEMA_TYPE_MISMATCH', location, `Expected ${types.join(' or ')} but received ${jsonType(value)}.`, { expected: types, actual: jsonType(value) }));
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => deepEqual(candidate, value))) {
    result.errors.push(issue('OPENAPI_SCHEMA_ENUM_MISMATCH', location, 'Value is not one of the schema enum values.', { expected: schema.enum, actual: value }));
  }
  if ('const' in schema && !deepEqual(schema.const, value)) result.errors.push(issue('OPENAPI_SCHEMA_CONST_MISMATCH', location, 'Value does not match the schema const value.', { expected: schema.const, actual: value }));
  validateSchemaBounds(schema, value, location, result);
  if (isObject(value) && !Array.isArray(value)) {
    for (const key of asArray(schema.required)) {
      if (typeof key === 'string' && !(key in value)) result.errors.push(issue('OPENAPI_SCHEMA_REQUIRED_PROPERTY_MISSING', `${location}.${key}`, `Required property ${key} is missing.`, { property: key }));
    }
    if (isObject(schema.properties)) {
      for (const [key, child] of Object.entries(schema.properties)) if (key in value) validateSimpleSchema(child, value[key], `${location}.${key}`, result);
    }
    if (schema.additionalProperties === false && isObject(schema.properties)) for (const key of Object.keys(value)) if (!(key in schema.properties)) result.errors.push(issue('OPENAPI_SCHEMA_ADDITIONAL_PROPERTY', `${location}.${key}`, `Property ${key} is not allowed by the schema.`));
    if (isObject(schema.additionalProperties)) for (const [key, child] of Object.entries(value)) if (!isObject(schema.properties) || !(key in schema.properties)) validateSimpleSchema(schema.additionalProperties, child, `${location}.${key}`, result);
  }
  if (Array.isArray(value) && isObject(schema.items)) value.forEach((item, index) => validateSimpleSchema(schema.items, item, `${location}[${index}]`, result));
}

function validateSchemaBounds(schema, value, location, result) {
  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) result.errors.push(issue('OPENAPI_SCHEMA_MIN_LENGTH', location, `String is shorter than ${schema.minLength}.`));
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) result.errors.push(issue('OPENAPI_SCHEMA_MAX_LENGTH', location, `String is longer than ${schema.maxLength}.`));
    if (typeof schema.pattern === 'string') try { if (!new RegExp(schema.pattern).test(value)) result.errors.push(issue('OPENAPI_SCHEMA_PATTERN_MISMATCH', location, 'String does not match the schema pattern.')); } catch { unsupported(result, 'OPENAPI_SCHEMA_PATTERN_INVALID'); }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) result.errors.push(issue('OPENAPI_SCHEMA_MINIMUM', location, `Number is less than ${schema.minimum}.`));
    if (typeof schema.maximum === 'number' && value > schema.maximum) result.errors.push(issue('OPENAPI_SCHEMA_MAXIMUM', location, `Number is greater than ${schema.maximum}.`));
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) result.errors.push(issue('OPENAPI_SCHEMA_EXCLUSIVE_MINIMUM', location, `Number must be greater than ${schema.exclusiveMinimum}.`));
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) result.errors.push(issue('OPENAPI_SCHEMA_EXCLUSIVE_MAXIMUM', location, `Number must be less than ${schema.exclusiveMaximum}.`));
    if (typeof schema.multipleOf === 'number' && schema.multipleOf > 0 && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-10) result.errors.push(issue('OPENAPI_SCHEMA_MULTIPLE_OF', location, `Number is not a multiple of ${schema.multipleOf}.`));
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) result.errors.push(issue('OPENAPI_SCHEMA_MIN_ITEMS', location, `Array has fewer than ${schema.minItems} items.`));
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) result.errors.push(issue('OPENAPI_SCHEMA_MAX_ITEMS', location, `Array has more than ${schema.maxItems} items.`));
    if (schema.uniqueItems === true && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) result.errors.push(issue('OPENAPI_SCHEMA_UNIQUE_ITEMS', location, 'Array items must be unique.'));
  }
  if (isObject(value) && !Array.isArray(value)) {
    const count = Object.keys(value).length;
    if (Number.isInteger(schema.minProperties) && count < schema.minProperties) result.errors.push(issue('OPENAPI_SCHEMA_MIN_PROPERTIES', location, `Object has fewer than ${schema.minProperties} properties.`));
    if (Number.isInteger(schema.maxProperties) && count > schema.maxProperties) result.errors.push(issue('OPENAPI_SCHEMA_MAX_PROPERTIES', location, `Object has more than ${schema.maxProperties} properties.`));
  }
}

function parseRequestUrl(request) {
  try { const url = new URL(String(request.url)); return /^https?:$/.test(url.protocol) ? url : null; } catch { return null; }
}
function bodyValue(part, maxBodyBytes) {
  const value = part.body_inline ?? part.body;
  const declaredSize = Number(part.body_size);
  if (value === undefined || value === null || value === '') {
    return declaredSize > 0 ? { missing: false, value: '', tooLarge: declaredSize > maxBodyBytes } : { missing: true };
  }
  if (Buffer.isBuffer(value)) return { missing: false, value, tooLarge: value.length > maxBodyBytes };
  if (typeof value === 'string') return { missing: false, value, tooLarge: Buffer.byteLength(value, 'utf8') > maxBodyBytes };
  return { missing: false, value: JSON.stringify(value), tooLarge: false };
}
function selectMediaType(content, actual) {
  for (const [type, value] of Object.entries(content)) if (type.toLowerCase() === actual) return value;
  const [actualType] = actual.split('/');
  return Object.entries(content).find(([type]) => type.toLowerCase() === `${actualType}/*`)?.[1] ?? null;
}
function mediaType(value) { return typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : null; }
function isJsonMediaType(value) { return value === 'application/json' || value.endsWith('+json'); }
function headersOf(headers) { return new Map(Object.entries(isObject(headers) ? headers : {}).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value)])); }
function typeMatches(value, type, nullable) { if (value === null) return type === 'null' || nullable; return (type === 'object' && isObject(value) && !Array.isArray(value)) || (type === 'array' && Array.isArray(value)) || (type === 'string' && typeof value === 'string') || (type === 'boolean' && typeof value === 'boolean') || (type === 'number' && typeof value === 'number' && Number.isFinite(value)) || (type === 'integer' && Number.isInteger(value)); }
function jsonType(value) { if (value === null) return 'null'; if (Array.isArray(value)) return 'array'; return typeof value; }
function unsupported(result, note) { result.unsupported.push(note); }
function issue(code, location, message, details = {}) { return { code, location, message, ...details }; }
function isObject(value) { return value !== null && typeof value === 'object'; }
function asArray(value) { return Array.isArray(value) ? value : []; }
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function safeDecode(value) { try { return decodeURIComponent(value); } catch { return value; } }
function deepEqual(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function cloneJson(value) { return JSON.parse(JSON.stringify(value)); }
function pointer(document, fragment) {
  if (!fragment) return document;
  if (!fragment.startsWith('/')) return undefined;
  return fragment.slice(1).split('/').reduce((value, token) => value?.[token.replace(/~1/g, '/').replace(/~0/g, '~')], document);
}
function normalizeLimit(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, fallback) : fallback;
}
function normalizeBatchLimit(value) {
  if (value === undefined) return DEFAULT_OPENAPI_FLOW_BATCH_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1) return DEFAULT_OPENAPI_FLOW_BATCH_LIMIT;
  return Math.min(value, MAX_OPENAPI_FLOW_BATCH_LIMIT);
}
