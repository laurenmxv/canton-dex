import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** The baseline actuator media types; v3 is the default for a wildcard or missing Accept. */
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
/** The answer for a request that the baseline sent through its error dispatch (401 or 403). */
export type Deny = (request: FastifyRequest, reply: FastifyReply) => FastifyReply;

/**
 * The first listed media type the actuator produces wins over any wildcard, whatever the
 * quality values, as observed on the baseline API.
 */
function healthMediaType(accept: string | undefined): string | undefined {
  if (!accept) return ACTUATOR_V3;
  const ranges = accept.split(',').map((range) => (range.split(';')[0] ?? '').trim().toLowerCase());
  const produced = ranges.find((range) => PRODUCED_MEDIA_TYPES.includes(range));
  if (produced) return produced;
  return ranges.some((range) => WILDCARD_MEDIA_TYPES.includes(range)) ? ACTUATOR_V3 : undefined;
}

async function withinTimeout(check: Indicator): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`No answer within ${String(INDICATOR_TIMEOUT_MS)} ms`));
    }, INDICATOR_TIMEOUT_MS);
  });
  try {
    await Promise.race([check(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Serves the public actuator health routes of the baseline API. `/actuator/health` and
 * readiness are UP only when every indicator succeeds; liveness does not check dependencies.
 * Other health paths are 404 with an empty body, like unknown actuator components. An Accept
 * without a produced type (406) and another method (405, with `Allow: GET`) went through
 * the baseline error dispatch, where the security chain answered 401 or 403.
 */
export function registerHealth(
  app: FastifyInstance,
  indicators: Readonly<Record<string, Indicator>>,
  deny: Deny,
): void {
  async function indicatorStatus(): Promise<Status> {
    const checks = Object.entries(indicators).map(async ([name, check]) => {
      try {
        await withinTimeout(check);
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
        // A Buffer keeps the exact baseline content type; Fastify adds a charset to strings.
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
