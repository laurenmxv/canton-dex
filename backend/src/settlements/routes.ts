import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireCaller } from '../iam/authentication.js';
import { InvalidRequest } from '../platform/errors.js';
import { sendJson } from '../platform/problems.js';
import { onlyWhitespace, parseInt32, pathUuid, queryParam, readJsonObject } from '../platform/request.js';
import { requireFamily, SETTLEMENT_STATUSES, type SettlementStatus } from './model.js';
import { deferredInput, requestRef, runInput, updatePolicyInput } from './requests.js';
import type { SettlementWorkflow } from './workflow.js';

const POLICY_PATH = '/v1/admin/pools/:poolId/settlement-policy/:type';
const DEFAULT_HISTORY_LIMIT = 25;

type PoolRequest = FastifyRequest<{ Params: { poolId: string } }>;
type PolicyRequest = FastifyRequest<{ Params: { poolId: string; type: string } }>;
type DeferredRequest = FastifyRequest<{ Params: { poolId: string; type: string; requestId: string } }>;

/** The required `poolId` query value; the first one counts when it repeats. */
function poolParam(request: FastifyRequest): string {
  const poolId = queryParam(request, 'poolId');
  if (poolId === null || onlyWhitespace(poolId)) throw new InvalidRequest('poolId is required');
  return poolId;
}

function optionalUuid(request: FastifyRequest, name: string): string | null {
  const value = queryParam(request, name);
  return value === null ? null : pathUuid(value);
}

function statusParam(request: FastifyRequest): SettlementStatus | null {
  const value = queryParam(request, 'status');
  if (value === null) return null;
  const status = SETTLEMENT_STATUSES.find((name) => name === value);
  if (status === undefined) throw new InvalidRequest('Unknown settlement status');
  return status;
}

export function registerSettlementRoutes(app: FastifyInstance, workflow: SettlementWorkflow): void {
  app.get('/v1/admin/settlement-requests', async (request, reply) => {
    const status = queryParam(request, 'status') ?? 'READY';
    if (status !== 'READY' && status !== 'active') throw new InvalidRequest('status must be READY or active');
    const queue = await workflow.queue(poolParam(request), requireCaller(request).account);
    const answer =
      status === 'active' ? queue : queue.filter((queued) => !queued.deferred && queued.request.status === 'READY');
    return sendJson(reply, 200, answer);
  });

  app.get('/v1/admin/settlements', async (request, reply) =>
    sendJson(reply, 200, await workflow.list(queryParam(request, 'poolId'), requireCaller(request).account)),
  );

  app.get(
    '/v1/admin/settlements/:settlementId',
    async (request: FastifyRequest<{ Params: { settlementId: string } }>, reply) =>
      sendJson(reply, 200, await workflow.get(pathUuid(request.params.settlementId), requireCaller(request).account)),
  );

  app.post('/v1/admin/pools/:poolId/settlements', async (request: PoolRequest, reply) => {
    const input = runInput(readJsonObject(request));
    return sendJson(reply, 202, await workflow.run(request.params.poolId, input, requireCaller(request).account));
  });

  app.get('/v1/admin/pools/:poolId/settlement-preview', async (request: PoolRequest, reply) => {
    const type = queryParam(request, 'type');
    if (type === null) throw new InvalidRequest('type is required');
    const retryOf = optionalUuid(request, 'retryOf');
    const requestId = optionalUuid(request, 'requestId');
    const caller = requireCaller(request).account;
    return sendJson(reply, 200, await workflow.preview(request.params.poolId, type, retryOf, requestId, caller));
  });

  app.put(
    '/v1/admin/pools/:poolId/settlement-requests/:type/:requestId/deferred',
    async (request: DeferredRequest, reply) => {
      const ref = requestRef(request.params.type, pathUuid(request.params.requestId));
      const deferred = deferredInput(readJsonObject(request));
      await workflow.setDeferred(request.params.poolId, ref, deferred, requireCaller(request).account);
      return reply.code(204).send();
    },
  );

  app.get('/v1/admin/pools/:poolId/settlement-history', async (request: PoolRequest, reply) => {
    const type = queryParam(request, 'type');
    const status = statusParam(request);
    const before = queryParam(request, 'before');
    const limitText = queryParam(request, 'limit');
    const limit = limitText === null ? DEFAULT_HISTORY_LIMIT : parseInt32(limitText);
    const caller = requireCaller(request).account;
    const family = type === null ? null : requireFamily(type);
    return sendJson(reply, 200, await workflow.history(request.params.poolId, family, status, before, limit, caller));
  });

  app.get(POLICY_PATH, async (request: PolicyRequest, reply) =>
    sendJson(
      reply,
      200,
      await workflow.policy(request.params.poolId, requireFamily(request.params.type), requireCaller(request).account),
    ),
  );

  app.put(POLICY_PATH, async (request: PolicyRequest, reply) => {
    const input = updatePolicyInput(readJsonObject(request));
    const caller = requireCaller(request).account;
    const family = requireFamily(request.params.type);
    return sendJson(reply, 200, await workflow.updatePolicy(request.params.poolId, family, input, caller));
  });

  app.get('/v1/admin/monitoring', async (request, reply) => {
    const poolId = poolParam(request);
    return sendJson(reply, 200, await workflow.monitoring(poolId, requireCaller(request).account));
  });
}
