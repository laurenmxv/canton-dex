// The golden form of one HTTP exchange, shared by the fixture builder and the checker.
import { createHash } from 'node:crypto';
import { normalize, normalizePath } from './normalize.mjs';

const REQUEST_HEADERS = [
  'content-type', 'accept', 'origin', 'access-control-request-method', 'access-control-request-headers',
  'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-forwarded-prefix', 'forwarded',
];
/** Connection management differs between servers and proxies; it is not API behavior. */
const TRANSPORT_HEADERS = new Set(['date', 'connection', 'keep-alive', 'content-length', 'transfer-encoding']);
/** Larger request bodies are probes of size limits; the golden set keeps their length and digest. */
const LARGE_BODY_CHARACTERS = 64 * 1024;

function pick(headers, names) {
  return Object.fromEntries(names.filter((name) => headers[name] !== undefined).map((name) => [name, headers[name]]));
}

/** The response headers that are API behavior, sorted by name. */
export function apiHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([name]) => !TRANSPORT_HEADERS.has(name))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

function jsonOrText(text, ids) {
  try {
    return { json: normalize(JSON.parse(text), ids) };
  } catch {
    return { text: normalize(text, ids) };
  }
}

function requestBody(text, ids) {
  if (text === undefined || text === '') return { empty: true };
  if (text.length > LARGE_BODY_CHARACTERS) {
    return { omitted: { characters: text.length, sha256: createHash('sha256').update(text).digest('hex') } };
  }
  return jsonOrText(text, ids);
}

/** Every response body is kept: a golden answer the checker cannot compare is an error. */
function responseBody(text, ids, name) {
  if (text === undefined || text === '') return { empty: true };
  if (text.length > LARGE_BODY_CHARACTERS) throw new Error(`${name}: response body of ${text.length} characters exceeds the golden limit`);
  return jsonOrText(text, ids);
}

/** `auth` names the caller kind, never a token. */
export function goldenExchange({ name, method, url, auth, requestHeaders, requestText, status, headers, responseText }, ids) {
  return {
    name,
    request: {
      method,
      path: normalizePath(url, ids),
      auth,
      headers: pick(requestHeaders, REQUEST_HEADERS),
      body: requestBody(requestText, ids),
    },
    response: { status, headers: normalize(apiHeaders(headers), ids), body: responseBody(responseText, ids, name) },
  };
}
