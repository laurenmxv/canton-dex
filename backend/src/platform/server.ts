import { maxHeaderSize } from 'node:http';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { firewallOptions, registerFirewall } from './firewall.js';
import { INVALID_REQUEST, problemFor, REQUEST_FAILED, sendProblem } from './problems.js';

/** The security headers that every baseline response carries. */
const SECURITY_HEADERS = {
  'cache-control': 'no-cache, no-store, max-age=0, must-revalidate',
  pragma: 'no-cache',
  expires: '0',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'x-xss-protection': '0',
} as const;
/**
 * Request bodies are bounded. The baseline accepted a 3 MiB field and rejected it during
 * validation; larger bodies get the same 400 answer.
 */
const BODY_LIMIT_BYTES = 8 * 1024 * 1024;
const BODY_TOO_LARGE = 'FST_ERR_CTP_BODY_TOO_LARGE';

export function createServer(): FastifyInstance {
  const app = Fastify({
    logger: {
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    // Container health checks poll every few seconds; other requests keep their logs.
    logController: new LogController({
      disableRequestLogging: (request) => request.url.startsWith('/actuator/health'),
    }),
    bodyLimit: BODY_LIMIT_BYTES,
    // A path variable, such as a 138-character contract id, is bounded only by the request line.
    routerOptions: { maxParamLength: maxHeaderSize },
    // A business GET route does not answer HEAD; the health routes declare HEAD themselves.
    exposeHeadRoutes: false,
    ...firewallOptions,
  });
  registerFirewall(app);
  app.addHook('onRequest', async (_request, reply) => {
    reply.headers(SECURITY_HEADERS);
  });
  // The baseline router never binds an empty path variable, so `/v1/pools/` matches no route.
  // This runs after authentication, so the not-found handler answers as for any unmatched path.
  app.addHook('preParsing', (request, reply, payload, done) => {
    const params: unknown = request.params;
    if (typeof params === 'object' && params !== null && Object.values(params).includes('')) {
      reply.callNotFound();
      return;
    }
    done(null, payload);
  });
  // Handlers read bodies with the baseline's content-type and JSON rules (`request.ts`).
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof Error && 'code' in error && error.code === BODY_TOO_LARGE) {
      return sendProblem(reply, { status: 400, detail: INVALID_REQUEST });
    }
    const problem = problemFor(error);
    if (problem) return sendProblem(reply, problem);
    request.log.error({ err: error }, `Request failed: ${request.method} ${request.url}`);
    return sendProblem(reply, { status: 500, detail: REQUEST_FAILED });
  });
  return app;
}
