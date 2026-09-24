// Shape-aware normalization of HTTP exchanges captured from the baseline backend, and the
// matcher that checks a live response against a normalized golden response.
//
// Only unstable identities and times become placeholders. Everything else, including names,
// symbols, descriptions, decimal strings, numbers, enums, nulls, array order and key presence,
// stays literal. Encodings that a stable string could resemble (base64, cursors, probe run ids) are
// normalized only in the fields that carry them. The remaining pattern rules match values no
// stable string of this API has: generated UUIDs, 00-prefixed contract ids of at least 66 hex
// digits, 1220-prefixed SHA-256 multihashes and runtime instants.
//
// Placeholders:
//   <uuid:N>      a generated UUID; N binds one value within a fixture set
//   <cid:N>       a Canton contract id (00 + hex)
//   <hash:N>      a 1220-prefixed SHA-256 multihash (update id, namespace, fingerprint)
//   HINT::<hash:N> a party id; the hint stays literal
//   <instant>     an ISO-8601 UTC timestamp ending in `Z`: no fraction, or
//                 3, 6 or 9 digits whose last group is not 000
//   <base64:NB>   base64 of N decoded bytes, in BASE64_FIELDS only
//   <cursor>      a settlement-history cursor: unpadded base64url of `<instant>|<uuid>`
//   <run>         the eight-hex run id of a framework probe user, in `displayName` only
//
// Ledger offsets (`*Offset` fields) keep their exact captured number in the golden files. The
// participant's own LocalNet activity moves them, so the matcher compares them by type: a
// non-negative safe integer. Every other number compares exactly.

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUIDS_IN_TEXT = new RegExp(UUID_PATTERN, 'gi');
const STABLE_UUIDS = new Set([
  '00000000-0000-0000-0000-000000000000', // an id no resource has
  '00000000-0000-0000-0000-000000000003', // the fixture operator's Keycloak subject
]);
const HASHES_IN_TEXT = /1220[0-9a-f]{64}/g;
const CONTRACT_ID = /^00[0-9a-f]{64,}$/;
/** Composite values such as `stateId:configId` and ledger-step keys such as `access:<poolId>`. */
const CONTRACT_IDS_IN_TEXT = /\b00[0-9a-f]{64,}/g;
const PARTY = /^(.+)::(1220[0-9a-f]{64})$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d+))?Z$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const HISTORY_CURSOR = /^[A-Za-z0-9_-]{40,}$/;
const CURSOR_TEXT = new RegExp(`^(\\S+)\\|(${UUID_PATTERN})$`);
const DECIMAL = /^-?\d+(?:\.(\d+))?$/;
const PLACEHOLDERS_IN_TEMPLATE = /<(uuid|cid|hash):\d+>|<run>/g;
const BOUND_PLACEHOLDERS = /<(?:uuid|cid|hash):\d+>/g;
const VALUE_PATTERNS = { uuid: UUID_PATTERN, cid: '00[0-9a-f]{64,}', hash: '1220[0-9a-f]{64}' };

/** Fields whose values are base64 bytes: wallet keys, signatures, hashes and topology. */
const BASE64_FIELDS = new Set(['publicKey', 'signature', 'multiHash', 'preparedTransactionHash', 'topologyTransactions']);
/** The settlement-history cursor, in the response and in the `before` query parameter. */
const CURSOR_FIELDS = new Set(['nextCursor', 'before']);
/** Framework probe users are named `framework[-role]-<8 hex>`; their display name repeats it. */
const RUN_ID_FIELDS = new Set(['displayName']);
const RUN_ID = /\b(framework(?:-other|-coerced|-extra)?)-[0-9a-f]{8}\b/g;
/** Ledger offsets depend on all participant history, including LocalNet's own activity. */
const OFFSET_FIELD = /offset$/i;
/** Daml `Numeric 10` values the ledger returns keep all ten fractional digits. */
const LEDGER_SCALE = 10;

function isCanonicalInstant(value) {
  const match = INSTANT.exec(value);
  if (!match) return false;
  const fraction = match[1];
  if (fraction === undefined) return true;
  return [3, 6, 9].includes(fraction.length) && !fraction.endsWith('000');
}

function isHistoryCursor(value) {
  if (!HISTORY_CURSOR.test(value) || value.length % 4 === 0) return false;
  const match = CURSOR_TEXT.exec(Buffer.from(value, 'base64url').toString('utf8'));
  return match !== null && isCanonicalInstant(match[1]);
}

function isBase64(value) {
  return value.length >= 4 && value.length % 4 === 0 && BASE64.test(value);
}

function base64Bytes(value) {
  return Buffer.from(value, 'base64').length;
}

/** One placeholder namespace; the same value always gets the same placeholder. */
export class Identities {
  #values = new Map();
  #counts = new Map();

  placeholder(kind, value) {
    const key = `${kind}:${value}`;
    if (!this.#values.has(key)) {
      const next = (this.#counts.get(kind) ?? 0) + 1;
      this.#counts.set(kind, next);
      this.#values.set(key, `<${kind}:${next}>`);
    }
    return this.#values.get(key);
  }
}

function normalizeText(text, ids, key) {
  // Contract ids go first: each one ends in a 1220 hash that must stay part of the id.
  const normalized = text
    .replace(UUIDS_IN_TEXT, (uuid) => (STABLE_UUIDS.has(uuid.toLowerCase()) ? uuid : ids.placeholder('uuid', uuid.toLowerCase())))
    .replace(CONTRACT_IDS_IN_TEXT, (cid) => ids.placeholder('cid', cid))
    .replace(HASHES_IN_TEXT, (hash) => ids.placeholder('hash', hash));
  return RUN_ID_FIELDS.has(key) ? normalized.replace(RUN_ID, '$1-<run>') : normalized;
}

/** `key` is the JSON property or query parameter that holds the value, if any. */
function normalizeString(value, ids, key = '') {
  if (INSTANT.test(value)) return '<instant>';
  if (CONTRACT_ID.test(value)) return ids.placeholder('cid', value);
  const party = PARTY.exec(value);
  if (party) return `${normalizeText(party[1], ids, key)}::${ids.placeholder('hash', party[2])}`;
  if (CURSOR_FIELDS.has(key) && isHistoryCursor(value)) return '<cursor>';
  if (BASE64_FIELDS.has(key) && isBase64(value)) return `<base64:${base64Bytes(value)}B>`;
  return normalizeText(value, ids, key);
}

export function normalize(value, ids = new Identities(), key = '') {
  if (typeof value === 'string') return normalizeString(value, ids, key);
  if (Array.isArray(value)) return value.map((item) => normalize(item, ids, key));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [normalizeText(name, ids, ''), normalize(item, ids, name)]));
  }
  return value;
}

/** Normalizes a URL path and query the same way as a body string. */
export function normalizePath(path, ids) {
  const [pathname, query = ''] = path.split('?');
  const segments = pathname.split('/').map((segment) => normalizeString(decodeURIComponent(segment), ids));
  if (query === '') return segments.join('/');
  const params = new URLSearchParams(query);
  const normalized = [...params].map(([key, item]) => `${key}=${normalizeString(item, ids, key)}`);
  return `${segments.join('/')}?${normalized.join('&')}`;
}

/**
 * Compares a live value with a normalized golden value. Placeholders bind on first use and
 * must then repeat exactly. Returns the list of differences; empty means compatible.
 *
 * `decimals: 'format'` is a PARTIAL comparison: decimal strings compare by notation instead of
 * value (a ten-digit ledger scale must stay ten digits, any other decimal must stay plain with no
 * trailing fractional zeros). It suits runs whose amounts legitimately differ and never counts
 * as full compatibility evidence; exact business-value assertions must supplement it.
 */
export function differences(actual, expected, bindings = new Map(), path = '$', options = {}, key = '') {
  if (typeof expected === 'string') return stringDifferences(actual, expected, bindings, path, options);
  if (typeof expected === 'number' && OFFSET_FIELD.test(key)) {
    return Number.isSafeInteger(actual) && actual >= 0 ? [] : [`${path}: ${describe(actual)} is not a ledger offset`];
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${path}: expected an array, got ${describe(actual)}`];
    if (actual.length !== expected.length) return [`${path}: expected ${expected.length} items, got ${actual.length}`];
    return expected.flatMap((item, index) => differences(actual[index], item, bindings, `${path}[${index}]`, options, key));
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return [`${path}: expected an object, got ${describe(actual)}`];
    const missing = Object.keys(expected).filter((name) => !(name in actual)).map((name) => `${path}.${name}: missing`);
    const extra = Object.keys(actual).filter((name) => !(name in expected)).map((name) => `${path}.${name}: unexpected`);
    const nested = Object.keys(expected).filter((name) => name in actual).flatMap((name) => differences(actual[name], expected[name], bindings, `${path}.${name}`, options, name));
    return [...missing, ...extra, ...nested];
  }
  return Object.is(actual, expected) ? [] : [`${path}: expected ${describe(expected)}, got ${describe(actual)}`];
}

/**
 * Only a ten-digit fraction that ends in zero proves the fixed ledger scale; the baseline
 * shows it for pool settings alone. Every other decimal is trimmed, so a trimmed value with
 * ten significant digits must not be read as a fixed scale.
 */
function decimalFormatDifferences(actual, expected, path) {
  const actualMatch = DECIMAL.exec(actual);
  if (!actualMatch) return [`${path}: ${describe(actual)} is not a plain decimal`];
  const expectedFraction = DECIMAL.exec(expected)[1] ?? '';
  const actualFraction = actualMatch[1] ?? '';
  if (expectedFraction.length === LEDGER_SCALE && expectedFraction.endsWith('0')) {
    return actualFraction.length === LEDGER_SCALE ? [] : [`${path}: ${actual} lost the ledger scale of ${expected}`];
  }
  return actualFraction.endsWith('0') ? [`${path}: ${actual} has trailing fractional zeros`] : [];
}

function stringDifferences(actual, expected, bindings, path, options) {
  if (typeof actual !== 'string') return [`${path}: expected a string, got ${describe(actual)}`];
  if (expected === '<instant>') return isCanonicalInstant(actual) ? [] : [`${path}: ${actual} is not a canonical UTC timestamp`];
  if (expected === '<cursor>') return isHistoryCursor(actual) ? [] : [`${path}: ${describe(actual)} is not a settlement-history cursor`];
  const bytes = /^<base64:(\d+)B>$/.exec(expected);
  if (bytes) {
    return isBase64(actual) && base64Bytes(actual) === Number(bytes[1]) ? [] : [`${path}: expected ${bytes[1]} base64 bytes`];
  }
  if (options.decimals === 'format' && DECIMAL.test(expected)) return decimalFormatDifferences(actual, expected, path);
  if (!expected.includes('<')) return actual === expected ? [] : [`${path}: expected ${describe(expected)}, got ${describe(actual)}`];
  return templateDifferences(actual, expected, bindings, path);
}

/** A template such as `dex-dvo::<hash:2>` or `<cid:3>`: each placeholder binds one value. */
function templateDifferences(actual, expected, bindings, path) {
  const pattern = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(PLACEHOLDERS_IN_TEMPLATE, (token, kind) =>
    token === '<run>' ? '[0-9a-f]{8}' : `(${VALUE_PATTERNS[kind]})`);
  const match = new RegExp(`^${pattern}$`).exec(actual);
  if (!match) return [`${path}: ${describe(actual)} does not match ${expected}`];
  const tokens = [...expected.matchAll(BOUND_PLACEHOLDERS)].map((token) => token[0]);
  const problems = [];
  tokens.forEach((token, index) => {
    const value = match[index + 1];
    if (bindings.has(token)) {
      // The first binding stays, so one wrong value is reported once, not at every later use.
      if (bindings.get(token) !== value) problems.push(`${path}: ${token} was ${bindings.get(token)}, now ${value}`);
      return;
    }
    const kind = token.split(':')[0];
    const repeated = [...bindings].find(([other, bound]) => bound === value && other.split(':')[0] === kind);
    if (repeated) problems.push(`${path}: ${token} repeats ${repeated[0]}`);
    bindings.set(token, value);
  });
  return problems;
}

const DESCRIBE_LIMIT = 120;

function describe(value) {
  const text = JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > DESCRIBE_LIMIT ? `${text.slice(0, DESCRIBE_LIMIT - 3)}...` : text;
}
