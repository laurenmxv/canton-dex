import type { Duplex } from 'node:stream';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PROBLEM_JSON, TOKEN_REQUIRED } from './problems.js';

/** The baseline HTTP server's HTML error page; the connection closes after it. */
function errorPage(status: number, reason: string): Buffer {
  const title = `HTTP Status ${String(status)} – ${reason}`;
  return Buffer.from(
    `<!doctype html><html lang="en"><head><title>${title}</title><style type="text/css">body {font-family:Tahoma,Arial,sans-serif;} h1, h2, h3, b {color:white;background-color:#525D76;} h1 {font-size:22px;} h2 {font-size:16px;} h3 {font-size:14px;} p {font-size:12px;} a {color:black;} .line {height:1px;background-color:#525D76;border:none;}</style></head><body><h1>${title}</h1></body></html>`,
  );
}

/** A raw answer for a connection that the HTTP parser cannot continue; it always closes. */
function rawAnswer(status: number, headers: string, body: Buffer): Buffer {
  const head = `HTTP/1.1 ${String(status)} \r\n${headers}Content-Length: ${String(body.length)}\r\nConnection: close\r\n\r\n`;
  return Buffer.concat([Buffer.from(head), body]);
}

type Rejection = 'malformed' | 'trace' | 'rejected';
const HTML = 'text/html;charset=utf-8';
const MALFORMED_PAGE = errorPage(400, 'Bad Request');
/** The baseline firewall's answer: the anonymous problem, without the security headers. */
const REJECTED = Buffer.from(JSON.stringify({ detail: TOKEN_REQUIRED, status: 401, title: 'Unauthorized' }));
const ERROR_PAGE_HEADERS = `Content-Type: ${HTML}\r\nContent-Language: en\r\n`;
const RAW_MALFORMED = rawAnswer(400, ERROR_PAGE_HEADERS, MALFORMED_PAGE);
const RAW_REJECTED = rawAnswer(401, `Content-Type: ${PROBLEM_JSON}\r\n`, REJECTED);
const RAW_CONNECT = rawAnswer(501, ERROR_PAGE_HEADERS, errorPage(501, 'Not Implemented'));
/** The HTTP server refused TRACE with this method list before the firewall answer. */
const TRACE_ALLOW = 'HEAD, DELETE, POST, GET, OPTIONS, PUT';
const ALLOWED_METHODS = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);

/** Characters the HTTP server refused anywhere in a request target. */
const INVALID_TARGET = /[^\x21-\x7e]|["#<>\\^`{|}]/;
/** Escapes the HTTP server refused while it decoded the path: malformed, `/`, `\` and NUL. */
const MALFORMED_ESCAPE = /%(?![0-9a-f]{2})|%2f|%5c|%00/i;
/** Encoded or raw path content that the firewall refused. */
const FIREWALL_BLOCKLIST = /%25|%2e|%3b|%0a|%0d|;|\/\/|(?:^|\/)\.\.?(?:\/|$)/i;
/** Line and paragraph separators, refused after decoding. */
const SEPARATORS = /[\u2028\u2029]/;

/** A decoded path that climbs above the root after dot segments are resolved. */
function escapesRoot(decoded: string): boolean {
  let depth = 0;
  for (const segment of decoded.split('/')) {
    if (segment === '..') depth -= 1;
    else if (segment !== '' && segment !== '.') depth += 1;
    if (depth < 0) return true;
  }
  return false;
}

/**
 * How the baseline treated a request target before any route: the HTTP server answered a
 * malformed target itself, and the firewall refused unusual methods and paths that are not
 * normalized. Path parameters (`;…`) were removed before the HTTP server decoded the path.
 */
function rejection(method: string, target: string): Rejection | undefined {
  const path = target.split('?', 1)[0] ?? '';
  const withoutParameters = path.replace(/;[^/]*/g, '');
  if (INVALID_TARGET.test(target) || MALFORMED_ESCAPE.test(withoutParameters)) return 'malformed';
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutParameters);
  } catch {
    return 'malformed';
  }
  if (escapesRoot(decoded)) return 'malformed';
  if (method === 'TRACE') return 'trace';
  if (!ALLOWED_METHODS.has(method) || FIREWALL_BLOCKLIST.test(path) || SEPARATORS.test(decoded)) {
    return 'rejected';
  }
  return undefined;
}

function sendRejection(reply: FastifyReply, kind: Rejection): FastifyReply {
  if (kind === 'malformed') {
    return reply
      .code(400)
      .header('content-type', HTML)
      .header('content-language', 'en')
      .header('connection', 'close')
      .send(MALFORMED_PAGE);
  }
  if (kind === 'trace') reply.header('allow', TRACE_ALLOW);
  return reply.code(401).header('content-type', PROBLEM_JSON).send(REJECTED);
}

/** Fastify options for targets that no hook sees: undecodable URLs and parser failures. */
export const firewallOptions = {
  frameworkErrors(error: FastifyError, _request: FastifyRequest, reply: FastifyReply): void {
    if (error.code === 'FST_ERR_BAD_URL') sendRejection(reply, 'malformed');
    else reply.code(400).send(error);
  },
  /** An unknown method gets the firewall answer; another parse failure, the error page. */
  clientErrorHandler(error: Error & { code?: string }, socket: Duplex): void {
    if (error.code?.startsWith('HPE_') && socket.writable) {
      socket.write(error.code === 'HPE_INVALID_METHOD' ? RAW_REJECTED : RAW_MALFORMED);
    }
    socket.destroy();
  },
};

/** Registers the request-target rules first, so their answers carry no security headers. */
export function registerFirewall(app: FastifyInstance): void {
  app.addHook('onRequest', (request, reply, done) => {
    const kind = rejection(request.raw.method ?? '', request.raw.url ?? '');
    if (kind === undefined) done();
    else sendRejection(reply, kind);
  });
  app.server.on('connect', (_request, socket: Duplex) => {
    socket.end(RAW_CONNECT);
  });
}
