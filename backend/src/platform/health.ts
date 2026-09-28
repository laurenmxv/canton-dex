import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** The actuator media types of the health routes; v3 is the default for a wildcard or missing Accept. */
const ACTUATOR_V3 = 'application/vnd.spring-boot.actuator.v3+json';
const ACTUATOR_V2 = 'application/vnd.spring-boot.actuator.v2+json';
const PRODUCED_MEDIA_TYPES = [ACTUATOR_V3, ACTUATOR_V2, 'application/json'];
const WILDCARD_MEDIA_TYPES = ['*/*', 'application/*'];
const GROUPS = ['liveness', 'readiness'];
const HEALTH = '/actuator/health';
const HEALTH_PATHS = [HEALTH, `${HEALTH}/*`];
const UNSUPPORTED_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
/** Readiness answers within the container health-check timeout, whatever a dependency does. */
const INDICATOR_TIMEOUT_MS = 2_000;

type Status = 'UP' | 'DOWN';
interface HealthBody {
  readonly groups?: readonly string[];
  readonly status: Status;
}
/** A readiness check resolves when its dependency is usable. */
export type Indicator = () => Promise<void>;
/** The 401 or 403 answer for an unacceptable Accept header or an unsupported method. */
export type Deny = (request: FastifyRequest, reply: FastifyReply) => FastifyReply;

/**
 * The first Accept media type that the health routes produce wins over any wildcard, whatever
 * the quality values.
 */
function healthMediaType(accept: string | undefined): string | undefined {
  if (!accept) return ACTUATOR_V3;
  const ranges = accept.split(',').map((range) => (range.split(';')[0] ?? '').trim().toLowerCase());
  const produced = ranges.find((range) => PRODUCED_MEDIA_TYPES.includes(range));
  if (produced) return produced;
  return ranges.some((range) => WILDCARD_MEDIA_TYPES.includes(range)) ? ACTUATOR_V3 : undefined;
}

async function withinTimeout(check: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`No answer within ${String(INDICATOR_TIMEOUT_MS)} ms`));
    }, INDICATOR_TIMEOUT_MS);
  });
  try {
    await Promise.race([check, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Serves the public actuator health routes. `/actuator/health` and readiness are UP only when
 * every indicator succeeds; liveness does not check dependencies. Other health paths are 404
 * with an empty body, like unknown actuator components. An Accept without a produced type and
 * another method (with `Allow: GET`) get the `deny` answer, 401 or 403, not 406 or 405.
 */
export function registerHealth(
  app: FastifyInstance,
  indicators: Readonly<Record<string, Indicator>>,
  deny: Deny,
): void {
  const pending = new Map<string, Promise<void>>();
  async function indicatorStatus(): Promise<Status> {
    const checks = Object.entries(indicators).map(async ([name, check]) => {
      try {
        const running =
          pending.get(name) ??
          Promise.resolve()
            .then(check)
            .finally(() => pending.delete(name));
        pending.set(name, running);
        await withinTimeout(running);
        return true;
      } catch (error) {
        app.log.warn({ indicator: name, err: error }, 'Health indicator is down');
        return false;
      }
    });
    return (await Promise.all(checks)).every(Boolean) ? 'UP' : 'DOWN';
  }

  async function answer(request: FastifyRequest, reply: FastifyReply, body: () => Promise<HealthBody | undefined>) {
    const mediaType = healthMediaType(request.headers.accept);
    if (mediaType === undefined) return deny(request, reply);
    const health = await body();
    if (health === undefined) return reply.code(404).send();
    return (
      reply
        .code(health.status === 'UP' ? 200 : 503)
        .header('content-type', mediaType)
        // A Buffer keeps the exact media type; Fastify adds a charset to strings.
        .send(Buffer.from(JSON.stringify(health)))
    );
  }

  const methods = ['GET', 'HEAD'];
  app.route({
    method: methods,
    url: HEALTH,
    handler: (request, reply) =>
      answer(request, reply, async () => ({ groups: GROUPS, status: await indicatorStatus() })),
  });
  app.route({
    method: methods,
    url: `${HEALTH}/readiness`,
    handler: (request, reply) => answer(request, reply, async () => ({ status: await indicatorStatus() })),
  });
  app.route({
    method: methods,
    url: `${HEALTH}/liveness`,
    handler: (request, reply) => answer(request, reply, () => Promise.resolve({ status: 'UP' })),
  });
  app.route({
    method: methods,
    url: `${HEALTH}/*`,
    handler: (request, reply) => answer(request, reply, () => Promise.resolve(undefined)),
  });
  for (const url of HEALTH_PATHS) {
    app.route({
      method: [...UNSUPPORTED_METHODS],
      url,
      handler: (request, reply) => deny(request, reply.header('allow', 'GET')),
    });
  }
}
