// One owner of "what does a request URL look like when mockttp matches it".
// The rule builder (tools.mjs) and the dry-run evaluator (proxy.mjs) both need
// that answer; when each approximated it separately they drifted apart and
// shipped rules that compiled fine but could never fire.
import legacyUrl from 'node:url';
import querystring from 'node:querystring';
import { isDeepStrictEqual } from 'node:util';

// Mockttp's QueryMatcher parses with url.parse(url, true), whose legacy
// querystring parser stops after this many pairs. Past the cap the parser
// silently drops parameters, so a derived matcher would hold keys mockttp
// never sees and the rule would never match.
export const MAX_QUERY_PARAMS = 1000;

// Total wire bytes a match_query may occupy, counted as the query string it
// has to match ('key=value' pairs joined by '&'). Moving the query out of
// url_pattern removed the only bound it had (compileSafeRegex caps a pattern
// at 500 characters), and a rule is persisted to rules.json and re-registered
// on every start_proxy, so an unbounded match_query is stored and replayed
// forever. That is the whole rationale: the bound is on what this server
// persists and replays, and it says nothing about what any other server,
// proxy, or client accepts on the wire.
export const MAX_QUERY_BYTES = 8192;

// capture_to_mock derives its query from a captured flow, so a caller who trips
// a bound on that path never supplied a match_query and cannot shorten one.
const DERIVED_QUERY_RECOVERY = Object.freeze([
  'Capture the same endpoint with a shorter query, or pick a flow carrying fewer parameters.',
  'Pass url_pattern to anchor the mock yourself; the captured query is then not matched at all.',
]);

const isAbsoluteUrl = (value) => value.toLowerCase().startsWith('http://')
  || value.toLowerCase().startsWith('https://');
const isRelativeUrl = (value) => value.startsWith('/');
const isAbsoluteProtocollessUrl = (value) => !isAbsoluteUrl(value) && !isRelativeUrl(value);

function nthIndexOf(input, matcher, n) {
  let index = -1;
  while (n > 0) {
    n -= 1;
    index = input.indexOf(matcher, index + 1);
    if (index === -1) break;
  }
  return index;
}

/**
 * Mirrors mockttp's internal normalizeUrl (mockttp/dist/util/url.js): cut
 * everything from the first '?', drop the fragment, upper-case percent
 * escapes, percent-encode non-ASCII, drop a trailing dot on the hostname and
 * drop a port that is the default for the scheme. test/url-match.test.mjs
 * guards this against the real implementation.
 */
export function normalizeMatchUrl(input) {
  let value = String(input ?? '');
  let parsed;
  let protocolless = false;
  try {
    const queryIndex = value.indexOf('?');
    if (queryIndex !== -1) value = value.slice(0, queryIndex);
    if (isAbsoluteProtocollessUrl(value)) {
      parsed = legacyUrl.parse(`http://${value}`);
      protocolless = true;
    } else {
      parsed = legacyUrl.parse(value);
    }
    delete parsed.host;
    delete parsed.query;
    delete parsed.search;
    delete parsed.hash;
    if (parsed.pathname) {
      parsed.pathname = parsed.pathname
        .replace(/%[A-Fa-z0-9]{2}/g, (encoded) => encoded.toUpperCase())
        .replace(/[^\u0000-\u007F]+/g, (unicodeChar) => encodeURIComponent(unicodeChar));
    }
    if (parsed.hostname?.endsWith('.')) parsed.hostname = parsed.hostname.slice(0, -1);
    if ((parsed.protocol === 'https:' && parsed.port === '443')
      || (parsed.protocol === 'http:' && parsed.port === '80')) {
      delete parsed.port;
    }
  } catch {
    if (!parsed) return value; // Totally unparseable: use as-is, as mockttp does.
  }
  const normalized = legacyUrl.format(parsed);
  return protocolless ? normalized.slice('http://'.length) : normalized;
}

// Mirrors mockttp's getPathFromAbsoluteUrl. Method-specific rules compile to a
// RegexPathMatcher, which tests the pattern against this path as well as the
// whole normalized URL.
export function matchUrlPath(absoluteUrl) {
  const value = String(absoluteUrl ?? '');
  const pathIndex = nthIndexOf(value, '/', 3);
  return pathIndex !== -1 ? value.slice(pathIndex) : '/';
}

/**
 * Splits a rule `url` into the part that becomes url_pattern and the query
 * that becomes match_query. The first '?' is ALWAYS the query separator: the
 * live proxy cuts the query before testing url_pattern, so a query left in the
 * pattern can never match. Callers who want a single-character wildcard pass
 * url_pattern instead, which bypasses this entirely — but url_pattern is a raw
 * regular expression, so the wildcard is written '.', not '?'.
 */
export function splitRuleUrl(value, { recovery = null } = {}) {
  const raw = String(value ?? '');
  // Per the URL spec everything after the first '#' is fragment, so a '?'
  // inside a fragment is not a query separator.
  const fragmentIndex = raw.indexOf('#');
  const withoutFragment = fragmentIndex < 0 ? raw : raw.slice(0, fragmentIndex);
  const separator = withoutFragment.indexOf('?');
  if (separator < 0) return { base: withoutFragment, query: null };
  const base = withoutFragment.slice(0, separator);
  const remainder = withoutFragment.slice(separator + 1);
  // A trailing bare '?' means "no query constraint", not an unmatchable rule.
  if (!remainder) return { base, query: null };
  return { base, query: parseMatchQuery(remainder, recovery) };
}

// Every matcher guard raises the same shape: a coded, non-retryable error
// carrying hints the caller can act on.
export function matcherError(code, message, recovery) {
  const error = new Error(message);
  error.code = code;
  error.retryable = false;
  error.recovery = recovery;
  return error;
}

/**
 * The gate every mockttp matcher object passes through — match_query here,
 * match_headers in proxy.mjs — on every path that can register a rule: tool
 * call, rule import, startup replay, update_rule patch.
 * mockttp compares each matcher with lodash isMatch, which is unconditionally
 * true against an empty expectation, so an empty matcher is not a weak
 * constraint but the absence of one: a blacklist meant for a single request
 * would block the whole path. An empty object also means a key can have gone
 * missing on the way in — a '__proto__' key assigned onto a '{}' literal writes
 * the prototype slot instead of an own property — so it has to fail loudly
 * either way. A non-object is rejected before anything spreads it, because
 * spreading a string or an array produces an index-keyed object ({0:'a'}) that
 * reads as a real constraint.
 * Returns false when there is no matcher at all, so callers can skip the
 * checks that only apply to a present one.
 */
export function validateMatcherObject(value, label, {
  code, invalidMessage, invalidRecovery, emptyMessage, emptyRecovery, recovery = null,
}) {
  if (value == null) return false;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw matcherError(`${code}_INVALID`, invalidMessage, recovery ?? invalidRecovery);
  }
  if (Object.keys(value).length === 0) {
    throw matcherError(`${code}_EMPTY`, emptyMessage, recovery ?? emptyRecovery);
  }
  return true;
}

function parseMatchQuery(search, recovery = null) {
  // querystring.parse is what url.parse(url, true) — and therefore mockttp's
  // QueryMatcher — uses, so parsing with it is parity by construction:
  // repeated keys collapse to arrays and a leading '?' stays part of the first
  // key, where URLSearchParams would eat it.
  const capped = querystring.parse(search);
  const complete = querystring.parse(search, '&', '=', { maxKeys: 0 });
  if (!isDeepStrictEqual(capped, complete)) {
    throw matcherError('QUERY_TOO_LARGE', `url query exceeds the ${MAX_QUERY_PARAMS} parameters the proxy can match; the rule could never fire`, recovery ?? [
      `Keep the url query to at most ${MAX_QUERY_PARAMS} parameters.`,
      'Pass url_pattern plus a small match_query instead of encoding every parameter in url.',
    ]);
  }
  // querystring.parse's null prototype is load-bearing: a '__proto__' key
  // assigned on a '{}' literal writes the prototype slot instead of an own
  // property, leaving an empty match_query — and mockttp's withQuery({})
  // matches every request. An empty parse is dropped for the same reason: it
  // reads as a constraint but is the absence of one.
  return Object.keys(capped).length === 0 ? null : capped;
}

/**
 * match_query's use of validateMatcherObject, plus the two bounds only a query
 * has. An empty array value is the empty matcher one level down — isMatch reads
 * [] as a vacuous subset of an array actual — and fails the same way. Past the
 * bounds the rule is dead in the other direction: mockttp parses the incoming
 * request with url.parse(url, true), whose parser stops at MAX_QUERY_PARAMS
 * pairs.
 */
export function validateMatchQuery(value, label = 'match_query', { recovery = null } = {}) {
  const present = validateMatcherObject(value, label, {
    code: 'MATCH_QUERY',
    recovery,
    invalidMessage: `${label} must be an object of query parameters`,
    invalidRecovery: [
      `Pass ${label} as {"key": "value"} or {"key": ["value", "other"]}.`,
      `Omit ${label} entirely for no query constraint.`,
    ],
    emptyMessage: `${label} has no parameters, and an empty query matcher matches every request`,
    // Nothing drops a key on the way in any more — the MCP schema keeps
    // '__proto__', and JSON.parse always made it an own property — so an empty
    // object here is the one the caller or the stored rule actually holds.
    emptyRecovery: [
      `Omit ${label} entirely for no query constraint.`,
      `Name at least one parameter in ${label}, or put the query in url and let it split.`,
      `A rule written, imported, or stored before this guard can carry ${label}: {} meaning "any query"; re-create it with the parameters it meant to constrain.`,
    ],
  });
  if (!present) return;
  const keys = Object.keys(value);
  let pairs = 0;
  let bytes = 0;
  for (const key of keys) {
    const raw = value[key];
    const items = Array.isArray(raw) ? raw : [raw];
    // An empty array is the per-key form of the empty object above: lodash
    // isMatch treats [] as a vacuous subset of an array actual, so it matches
    // whatever values a repeated parameter arrives with — a constraint that
    // reads like one but is not. (A scalar actual does not match, so the rule
    // is unpredictable rather than merely broad.) It also used to cost nothing
    // here, so a key of any length added 0 pairs and 0 bytes and walked past
    // both bounds. Rejecting it keeps every key worth at least its own bytes,
    // because every key now contributes at least one wire pair.
    if (items.length === 0) {
      throw matcherError('MATCH_QUERY_EMPTY_VALUE', `${label}.${key} is an empty array, which matches any values a repeated ${key} arrives with`, recovery ?? [
        `Name the value ${key} must have, e.g. {"${key}": ["value"]}.`,
        `Drop ${key} from ${label} if any value of it is acceptable.`,
      ]);
    }
    // A repeated key is one wire pair per value, and the parser cap counts
    // wire pairs, so an array counts once per element.
    pairs += items.length;
    for (const item of items) bytes += Buffer.byteLength(`${key}=${item ?? ''}&`);
  }
  if (pairs > MAX_QUERY_PARAMS) {
    throw matcherError('QUERY_TOO_LARGE', `${label} holds ${pairs} parameters, past the ${MAX_QUERY_PARAMS} the proxy can match; the rule could never fire`, recovery ?? [
      `Keep ${label} to at most ${MAX_QUERY_PARAMS} parameters.`,
      'Match the few parameters that identify the request rather than every one of them.',
    ]);
  }
  if (bytes > MAX_QUERY_BYTES) {
    throw matcherError('QUERY_TOO_LARGE', `${label} is ${bytes} bytes, past the ${MAX_QUERY_BYTES}-byte limit on what a rule may persist and replay`, recovery ?? [
      `Keep ${label} under ${MAX_QUERY_BYTES} bytes in total.`,
      'Match the few parameters that identify the request rather than every one of them.',
    ]);
  }
}

/**
 * Mirrors _.isMatch(url.parse(url, true).query, match_query) — literally what
 * mockttp's QueryMatcher runs — for the shapes match_query can hold
 * (string | string[]). The dry run used to wrap a scalar actual in an array,
 * so match_query {b: ['1']} against ?b=1 reported a match the live proxy never
 * makes: querystring only builds an array for a repeated key, and lodash
 * compares a scalar with === and an array by tag, so ['1'] is never '1'.
 */
export function queryMatches(actualQuery, expectedQuery) {
  const actual = actualQuery ?? {};
  const expected = expectedQuery ?? {};
  for (const key of Object.keys(expected)) {
    // url.parse builds the live query with a null prototype, so lodash's
    // `key in object` there sees own keys only.
    if (!Object.hasOwn(actual, key)) return false;
    // QueryMatcher stringifies its expectation in its constructor, and every
    // value url.parse produces is already a string.
    const expectedValue = expected[key];
    const actualValue = actual[key];
    if (Array.isArray(expectedValue) !== Array.isArray(actualValue)) return false;
    if (!Array.isArray(expectedValue)) {
      if (String(expectedValue) !== String(actualValue)) return false;
      continue;
    }
    // lodash compares arrays here partially and unordered: the expectation has
    // to be a multiset subset of what arrived, in any order.
    const remaining = new Map();
    for (const item of actualValue) {
      const value = String(item);
      remaining.set(value, (remaining.get(value) ?? 0) + 1);
    }
    for (const item of expectedValue) {
      const value = String(item);
      const left = remaining.get(value) ?? 0;
      if (left === 0) return false;
      remaining.set(value, left - 1);
    }
  }
  return true;
}

// Glob to anchored regex: '*' is any run of characters and '?' is any single
// character. In a rule `url` the first '?' never reaches here — splitRuleUrl
// has already cut the query off — so '?' only keeps its glob meaning in the
// flow filters that share this helper. Only a human-written url gets glob
// semantics; see literalUrlPattern for the machine-derived case.
export function urlPattern(value) {
  if (!value) return null;
  const escaped = String(value).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return `^${escaped.replaceAll('*', '.*').replaceAll('?', '.')}$`;
}

// The same anchored regex with no glob semantics at all: every metacharacter is
// escaped, '*' included. A URL taken off the wire is text, not a pattern — a
// captured path holding a literal '*' must match that path and nothing else, or
// capture_to_mock builds a rule broader than the flow it came from.
export function literalUrlPattern(value) {
  if (!value) return null;
  return `^${String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

/**
 * The query mockttp's QueryMatcher sees: url.parse(url, true) runs the legacy
 * querystring parser, which stops at MAX_QUERY_PARAMS pairs where
 * URLSearchParams has no cap at all. The dry run reads the request through this
 * so it cannot report a match the live proxy would never make past the cap.
 */
export function parseRequestQuery(requestUrl) {
  return legacyUrl.parse(String(requestUrl ?? ''), true).query;
}

/**
 * Turns a rule `url` into the matchers mockttp is given. Every rule-creating
 * path routes through here — the tools, and the engine for anything that
 * arrives with a raw url (an update_rule patch, an imported or replayed rule)
 * — so the friendly surface behaves identically everywhere.
 * A caller-supplied url_pattern or match_query always wins; derived query
 * parameters only fill the gaps so intent is preserved, never clobbered.
 * `normalize` is for machine-derived URLs (a captured flow): the pattern is
 * built from the exact text mockttp will test, so a captured default port or
 * lowercase escape cannot produce a rule that can never fire, and it is built
 * literally, because a URL off the wire is text and never a glob. A
 * hand-written url keeps its wildcards — what you wrote is what gets matched.
 */
export function ruleUrlMatchers(url, args = {}, { normalize = false } = {}) {
  // Nothing behind a derived url was written by the caller, so a rejected query
  // has to be recovered from by changing the capture, not by editing a
  // match_query they never supplied.
  const recovery = normalize ? DERIVED_QUERY_RECOVERY : null;
  // Before the spread below, not after it: spreading a string or an array
  // produces an index-keyed object ({0:'a',1:'b'}) that reads as a real
  // constraint. import_rules, a hand-written rules.json and a direct
  // registerRule all reach the engine through here, so validating here is what
  // gives every path the same coded error.
  validateMatchQuery(args.match_query, 'match_query', { recovery });
  if (args.url_pattern != null) return { url_pattern: args.url_pattern, match_query: args.match_query };
  const { base, query } = splitRuleUrl(url, { recovery });
  const pattern = normalize ? literalUrlPattern(normalizeMatchUrl(base)) : urlPattern(base);
  if (!query) return { url_pattern: pattern, match_query: args.match_query };
  // Null prototype: '__proto__' must stay an own key, or the merged object
  // collapses to {} and withQuery({}) matches every request.
  const merged = { __proto__: null, ...query, ...args.match_query };
  // The engine validates this again at registration, but only the call that
  // derived it knows whether the caller can act on hints about match_query.
  validateMatchQuery(merged, 'match_query', { recovery });
  return { url_pattern: pattern, match_query: merged };
}
