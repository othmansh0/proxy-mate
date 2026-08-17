import test from 'node:test';
import assert from 'node:assert/strict';
import legacyUrl from 'node:url';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  normalizeMatchUrl, matchUrlPath, splitRuleUrl, queryMatches, validateMatchQuery,
  MAX_QUERY_PARAMS, MAX_QUERY_BYTES,
} from '../src/lib/url-match.mjs';

// Deliberately reaches into mockttp internal paths. normalizeUrl and
// QueryMatcher are not part of mockttp's public API, but every rule we build is
// matched through them, so a mockttp upgrade that changes URL or query matching
// must fail loudly right here rather than silently turning live rules into dead
// ones (or, worse, into rules that match everything).
const require = createRequire(import.meta.url);
const MOCKTTP_URL_MODULE = fileURLToPath(new URL('../node_modules/mockttp/dist/util/url.js', import.meta.url));
const MOCKTTP_MATCHERS_MODULE = fileURLToPath(new URL('../node_modules/mockttp/dist/rules/matchers.js', import.meta.url));
const { normalizeUrl: mockttpNormalizeUrl } = require(MOCKTTP_URL_MODULE);
const { QueryMatcher } = require(MOCKTTP_MATCHERS_MODULE);

const PARITY_CORPUS = [
  // Default and non-default ports, per scheme.
  'http://example.com/path',
  'http://example.com:80/path',
  'https://example.com:443/path',
  'http://example.com:8080/path',
  'https://example.com:8443/path',
  'http://example.com:80',
  'https://example.com:443',
  'ws://example.com:80/socket',
  // Queries and fragments.
  'http://example.com/path?a=1&b=2',
  'http://example.com/path#frag',
  'http://example.com/path#frag?a=1',
  'http://example.com/path?a=1#frag',
  'http://example.com/path?',
  // Encoded and non-ASCII characters.
  'http://example.com/p%2fx',
  'http://example.com/p%2Fx',
  'http://example.com/a b',
  'http://example.com/ünïcode',
  'http://例え.test/パス',
  // Protocol-less, relative and wildcard forms.
  'example.com/path',
  'example.com:80/path',
  '/relative/path',
  '/relative/path?x=1',
  '*/v1/users',
  'http://host/v?/users',
  // Trailing dots, credentials, IPv6, empty.
  'http://example.com./path',
  'http://example.com.:80/path',
  'http://user:pass@example.com:80/path',
  'http://[::1]:80/path',
  'http://[::1]:8080/path',
  'http://example.com',
  'http://example.com/path/',
  '',
];

test('normalizeMatchUrl agrees with mockttp normalizeUrl across the matching corpus', () => {
  for (const url of PARITY_CORPUS) {
    assert.equal(normalizeMatchUrl(url), mockttpNormalizeUrl(url), url);
  }
  // Spot-check the two normalizations rules actually depend on, so a parity
  // failure is legible even if mockttp changed in the same direction.
  assert.equal(normalizeMatchUrl('http://origin.invalid:80/v1/x'), 'http://origin.invalid/v1/x');
  assert.equal(normalizeMatchUrl('http://origin.invalid/v1/x?a=1#f'), 'http://origin.invalid/v1/x');
});

test('matchUrlPath mirrors the path mockttp tests method-specific rules against', () => {
  assert.equal(matchUrlPath('http://example.com/v1/secret'), '/v1/secret');
  assert.equal(matchUrlPath('http://example.com:8080/v1/secret'), '/v1/secret');
  assert.equal(matchUrlPath('http://example.com'), '/');
  assert.equal(matchUrlPath(normalizeMatchUrl('http://example.com:80/v1/secret?a=1')), '/v1/secret');
});

// splitRuleUrl builds the query with a null prototype (see the pollution test
// below), so flatten it into a plain object before comparing shapes.
function split(url) {
  const { base, query } = splitRuleUrl(url);
  return { base, query: query === null ? null : { ...query } };
}

test('splitRuleUrl always treats the first query-position ? as the separator', () => {
  assert.deepEqual(split('http://api.test/v1/users'), { base: 'http://api.test/v1/users', query: null });
  assert.deepEqual(split('http://api.test/v1/users?active=1'), {
    base: 'http://api.test/v1/users', query: { active: '1' },
  });
  // A flag parameter has an empty value, exactly as url.parse reports it.
  assert.deepEqual(split('http://api.test/v1/users?debug'), {
    base: 'http://api.test/v1/users', query: { debug: '' },
  });
  // '?' is no longer a single-character glob in a rule url.
  assert.deepEqual(split('http://api.test/v?/users'), {
    base: 'http://api.test/v', query: { '/users': '' },
  });
  // Repeated keys collapse to arrays, which match_query accepts.
  assert.deepEqual(split('http://api.test/a?b=1&b=2&c=3').query, { b: ['1', '2'], c: '3' });
});

test('splitRuleUrl treats a trailing bare ? as no query constraint', () => {
  assert.deepEqual(split('http://api.test/v2/items?'), { base: 'http://api.test/v2/items', query: null });
  // An empty parse is the absence of a constraint too: withQuery({}) matches
  // every request, so it must never be emitted as one.
  assert.deepEqual(split('http://api.test/v2/items?&'), { base: 'http://api.test/v2/items', query: null });
});

test('splitRuleUrl strips the fragment before looking for the query', () => {
  // Everything after '#' is fragment, so this '?' is not a separator.
  assert.deepEqual(split('http://api.test/a#frag?b=1'), { base: 'http://api.test/a', query: null });
  assert.deepEqual(split('http://api.test/a?b=1#frag'), { base: 'http://api.test/a', query: { b: '1' } });
  assert.deepEqual(split('http://api.test/a#frag'), { base: 'http://api.test/a', query: null });
});

test('splitRuleUrl keeps prototype-shaped query keys as own properties', () => {
  const { query } = splitRuleUrl('http://api.test/a?__proto__=evil&constructor=c&prototype=p');
  // A '{}' accumulator writes the prototype slot for '__proto__' instead of an
  // own key, leaving {} behind — and mockttp's withQuery({}) matches every
  // request, so a one-query blacklist would block the whole path.
  assert.equal(Object.getPrototypeOf(query), null);
  assert.deepEqual(Object.keys(query), ['__proto__', 'constructor', 'prototype']);
  assert.equal(query['__proto__'], 'evil');
  assert.equal(query.constructor, 'c');
  assert.equal(JSON.stringify(query), '{"__proto__":"evil","constructor":"c","prototype":"p"}');
  // Nothing leaked into the global prototype.
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
  assert.equal({}.evil, undefined);
});

test('splitRuleUrl refuses queries past the parser cap instead of building a dead rule', () => {
  const atCap = Array.from({ length: MAX_QUERY_PARAMS }, (_, index) => `k${index}=v`).join('&');
  assert.equal(Object.keys(splitRuleUrl(`http://api.test/a?${atCap}`).query).length, MAX_QUERY_PARAMS);
  // The cap is mockttp's: QueryMatcher parses with url.parse(url, true), whose
  // legacy querystring parser silently drops everything past 1000 pairs.
  assert.equal(Object.keys(legacyUrl.parse(`http://api.test/a?${atCap}`, true).query).length, MAX_QUERY_PARAMS);

  const pastCap = `${atCap}&k${MAX_QUERY_PARAMS}=v`;
  assert.equal(Object.keys(legacyUrl.parse(`http://api.test/a?${pastCap}`, true).query).length, MAX_QUERY_PARAMS);
  assert.throws(() => splitRuleUrl(`http://api.test/a?${pastCap}`), (error) => {
    assert.equal(error.code, 'QUERY_TOO_LARGE');
    assert.equal(error.retryable, false);
    assert.ok(error.recovery.length > 0);
    return true;
  });
});

// [request url, match_query, expected verdict]. Each row is checked twice: once
// against queryMatches, once against the real mockttp QueryMatcher, so the
// suite fails whether our semantics drift or mockttp's do.
const QUERY_MATCH_CORPUS = [
  // A repeated key is the only thing querystring turns into an array, and
  // lodash compares a scalar with === — so ['1'] is never the scalar '1'.
  ['http://h.test/a?b=1', { b: '1' }, true],
  ['http://h.test/a?b=1', { b: ['1'] }, false],
  ['http://h.test/a?b=1&b=2', { b: '1' }, false],
  // An array expectation is a multiset subset of what arrived, order ignored.
  ['http://h.test/a?b=1&b=2', { b: ['1'] }, true],
  ['http://h.test/a?b=1&b=2', { b: ['2', '1'] }, true],
  ['http://h.test/a?b=1&b=2', { b: ['1', '2', '3'] }, false],
  ['http://h.test/a?b=1&b=2', { b: ['1', '1'] }, false],
  ['http://h.test/a?b=1&b=1', { b: ['1', '1'] }, true],
  ['http://h.test/a?a=1&a=2&a=3', { a: ['3', '1'] }, true],
  ['http://h.test/a?b=1', { b: [] }, false],
  ['http://h.test/a?b=1&b=2', { b: [] }, true],
  // A missing key never matches, and a flag parameter carries an empty value.
  ['http://h.test/a?b=1', { c: '1' }, false],
  ['http://h.test/a?b=', { b: '' }, true],
  ['http://h.test/a?b', { b: '' }, true],
  ['http://h.test/a', { b: '' }, false],
  ['http://h.test/a?b=1&c=2', { b: '1', c: '2' }, true],
  ['http://h.test/a?b=1&c=2', { b: '1', c: '3' }, false],
  // url.parse builds the live query with a null prototype, so inherited keys
  // are not present and '__proto__' is an ordinary own key.
  ['http://h.test/a?__proto__=evil', JSON.parse('{"__proto__":"evil"}'), true],
  ['http://h.test/a?b=1', JSON.parse('{"constructor":"c"}'), false],
  ['http://h.test/a?b=1', JSON.parse('{"toString":"t"}'), false],
];

test('queryMatches mirrors the lodash isMatch semantics mockttp matches queries with', () => {
  for (const [url, expected, verdict] of QUERY_MATCH_CORPUS) {
    const { query } = legacyUrl.parse(url, true);
    const label = `${url} vs ${JSON.stringify(expected)}`;
    assert.equal(queryMatches(query, expected), verdict, label);
    assert.equal(new QueryMatcher(expected).matches({ url }), verdict, `mockttp: ${label}`);
  }
  // No constraint matches anything; an empty one does too, which is precisely
  // why validateMatchQuery refuses to let an empty one be registered.
  assert.equal(queryMatches({ b: '1' }, null), true);
  assert.equal(queryMatches({ b: '1' }, {}), true);
  assert.equal(new QueryMatcher({}).matches({ url: 'http://h.test/a?b=1' }), true);
  assert.equal(new QueryMatcher({}).matches({ url: 'http://h.test/anything' }), true);
});

test('validateMatchQuery refuses a match_query that can only match everything', () => {
  assert.throws(() => validateMatchQuery({}), (error) => {
    assert.equal(error.code, 'MATCH_QUERY_EMPTY');
    assert.equal(error.retryable, false);
    assert.ok(error.recovery.some((hint) => /Omit match_query/.test(hint)));
    return true;
  });
  // The realistic way to arrive here: a '__proto__' key assigned onto a '{}'
  // literal writes the prototype slot instead of an own property, leaving the
  // caller's one-parameter constraint as {}. (rules.engine.test.mjs shows zod
  // doing exactly that to a real tool call.)
  const collapsed = {};
  collapsed['__proto__'] = 'evil';
  assert.throws(() => validateMatchQuery(collapsed), (error) => error.code === 'MATCH_QUERY_EMPTY');
  // An own '__proto__' key is a real constraint and stays one.
  validateMatchQuery(JSON.parse('{"__proto__":"evil"}'));
  // No constraint at all is always fine.
  validateMatchQuery(null);
  validateMatchQuery(undefined);
});

test('validateMatchQuery rejects values that are not query-parameter objects', () => {
  for (const value of ['a=1', 42, true, [['a', '1']], () => {}]) {
    assert.throws(() => validateMatchQuery(value), (error) => {
      assert.equal(error.code, 'MATCH_QUERY_INVALID');
      assert.equal(error.retryable, false);
      return true;
    }, JSON.stringify(value) ?? String(value));
  }
});

test('validateMatchQuery rejects an empty-array value instead of letting it cost nothing', () => {
  // mockttp runs _.isMatch, for which an expected [] is a vacuous subset: it
  // matches whatever value the key holds. It is the same "empty constraint
  // matches everything" mistake as MATCH_QUERY_EMPTY, one level down.
  assert.equal(new QueryMatcher({ b: [] }).matches({ url: 'http://h.test/a?b=1&b=2' }), true);
  assert.throws(() => validateMatchQuery({ b: [] }), (error) => {
    assert.equal(error.code, 'MATCH_QUERY_EMPTY_VALUE');
    assert.equal(error.retryable, false);
    assert.ok(error.recovery.length > 0);
    return true;
  });

  // It was also free: iterating array elements charged an empty array 0 pairs
  // and 0 bytes however long its key, so it slipped past both bounds.
  const longKey = 'k'.repeat(MAX_QUERY_BYTES * 2);
  assert.throws(() => validateMatchQuery({ [longKey]: [] }), (error) => error.code === 'MATCH_QUERY_EMPTY_VALUE');

  // Pair-count path: 1000 real pairs plus one free key used to total 1000.
  const atCap = Object.fromEntries(Array.from({ length: MAX_QUERY_PARAMS }, (_, index) => [`k${index}`, 'v']));
  assert.throws(
    () => validateMatchQuery({ ...atCap, extra: [] }),
    (error) => error.code === 'MATCH_QUERY_EMPTY_VALUE',
  );

  // Byte-count path: a query already at the byte limit plus a free long key.
  assert.throws(
    () => validateMatchQuery({ k: 'v'.repeat(MAX_QUERY_BYTES - 'k=&'.length), [longKey]: [] }),
    (error) => error.code === 'MATCH_QUERY_EMPTY_VALUE',
  );
});

test('validateMatchQuery bounds a match_query by wire pairs and total size', () => {
  const atCap = Object.fromEntries(Array.from({ length: MAX_QUERY_PARAMS }, (_, index) => [`k${index}`, 'v']));
  validateMatchQuery(atCap);
  assert.throws(() => validateMatchQuery({ ...atCap, extra: 'v' }), (error) => {
    assert.equal(error.code, 'QUERY_TOO_LARGE');
    assert.equal(error.retryable, false);
    assert.ok(error.recovery.length > 0);
    return true;
  });
  // A repeated key is one wire pair per value, and url.parse counts wire pairs.
  assert.throws(
    () => validateMatchQuery({ k: Array.from({ length: MAX_QUERY_PARAMS + 1 }, () => 'v') }),
    (error) => error.code === 'QUERY_TOO_LARGE',
  );

  // Size: the query left url_pattern, so it left the 500-character bound too.
  validateMatchQuery({ k: 'v'.repeat(MAX_QUERY_BYTES - 'k=&'.length) });
  assert.throws(
    () => validateMatchQuery({ k: 'v'.repeat(MAX_QUERY_BYTES) }),
    (error) => error.code === 'QUERY_TOO_LARGE' && /bytes/.test(error.message),
  );
  // Multi-byte characters are counted as the bytes they occupy on the wire.
  assert.throws(
    () => validateMatchQuery({ k: 'é'.repeat(MAX_QUERY_BYTES / 2) }),
    (error) => error.code === 'QUERY_TOO_LARGE',
  );
});
