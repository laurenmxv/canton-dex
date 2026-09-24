import type { FastifyInstance } from 'fastify';
import { requireCaller } from '../iam/authentication.js';
import { sendJson } from '../platform/problems.js';
import { pathUuid, readJsonObject } from '../platform/request.js';
import { createProposal } from './requests.js';
import type { PoolStore } from './store.js';
import type { PoolWorkflow } from './workflow.js';

interface ProposalParams {
  readonly proposalId: string;
}

interface PoolParams {
  readonly poolId: string;
}

/** The operator's pool proposals and catalog, and the pool detail that every account reads. */
export function registerPoolRoutes(app: FastifyInstance, store: PoolStore, workflow: PoolWorkflow): void {
  app.get('/v1/admin/pool-proposals/options', async (_request, reply) =>
    sendJson(reply, 200, await workflow.options()),
  );

  app.get('/v1/admin/pool-proposals', async (_request, reply) => sendJson(reply, 200, await store.proposals()));

  app.post('/v1/admin/pool-proposals', async (request, reply) => {
    const input = createProposal(readJsonObject(request));
    return sendJson(reply, 202, await workflow.create(input, requireCaller(request).account));
  });

  app.get<{ Params: ProposalParams }>('/v1/admin/pool-proposals/:proposalId', async (request, reply) =>
    sendJson(reply, 200, await store.get(pathUuid(request.params.proposalId))),
  );

  app.post<{ Params: ProposalParams }>('/v1/admin/pool-proposals/:proposalId/withdraw', async (request, reply) => {
    const id = pathUuid(request.params.proposalId);
    return sendJson(reply, 202, await workflow.withdraw(id, requireCaller(request).account));
  });

  app.get('/v1/admin/pools', async (_request, reply) => sendJson(reply, 200, await workflow.pools()));

  app.get<{ Params: PoolParams }>('/v1/pools/:poolId', async (request, reply) =>
    sendJson(reply, 200, await workflow.pool(request.params.poolId)),
  );
}
