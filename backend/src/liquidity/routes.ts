import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireCaller } from '../iam/authentication.js';
import { sendJson } from '../platform/problems.js';
import { pathUuid, readJsonObject } from '../platform/request.js';
import { submission } from '../swaps/requests.js';
import type { Kind } from './model.js';
import { depositQuoteInput, prepareDepositInput, prepareWithdrawalInput, withdrawalQuoteInput } from './requests.js';
import type { LiquidityWorkflow } from './workflow.js';

type ById = FastifyRequest<{ Params: { requestId: string } }>;

/** The submit, status and recovery routes of one request kind. */
function registerRequestRoutes(app: FastifyInstance, workflow: LiquidityWorkflow, kind: Kind, root: string): void {
  app.post(`${root}/submit`, async (request, reply) => {
    const caller = requireCaller(request);
    const input = submission(readJsonObject(request));
    return sendJson(reply, 202, await workflow.submit(kind, caller.account, caller.accessToken, input));
  });

  app.get(`${root}/:requestId`, async (request: ById, reply) =>
    sendJson(reply, 200, await workflow.get(pathUuid(request.params.requestId), kind, requireCaller(request).account)),
  );

  app.post(`${root}/:requestId/cancel/prepare`, async (request: ById, reply) => {
    const id = pathUuid(request.params.requestId);
    const caller = requireCaller(request);
    return sendJson(reply, 200, await workflow.prepareRecovery(id, kind, caller.account, caller.accessToken));
  });

  app.post(`${root}/:requestId/cancel/submit`, async (request: ById, reply) => {
    const id = pathUuid(request.params.requestId);
    const caller = requireCaller(request);
    const input = submission(readJsonObject(request));
    return sendJson(reply, 202, await workflow.recover(id, kind, caller.account, caller.accessToken, input));
  });
}

export function registerLiquidityRoutes(app: FastifyInstance, workflow: LiquidityWorkflow): void {
  app.post('/v1/lp/deposit/quote', async (request, reply) => {
    const caller = requireCaller(request);
    const input = depositQuoteInput(readJsonObject(request));
    return sendJson(reply, 200, await workflow.quoteDeposit(caller.account, caller.accessToken, input));
  });

  app.post('/v1/lp/deposit/prepare', async (request, reply) => {
    const caller = requireCaller(request);
    const input = prepareDepositInput(readJsonObject(request));
    return sendJson(reply, 200, await workflow.prepareDeposit(caller.account, caller.accessToken, input));
  });

  app.post('/v1/lp/withdraw/quote', async (request, reply) => {
    const caller = requireCaller(request);
    const input = withdrawalQuoteInput(readJsonObject(request));
    return sendJson(reply, 200, await workflow.quoteWithdrawal(caller.account, caller.accessToken, input));
  });

  app.post('/v1/lp/withdraw/prepare', async (request, reply) => {
    const caller = requireCaller(request);
    const input = prepareWithdrawalInput(readJsonObject(request));
    return sendJson(reply, 200, await workflow.prepareWithdrawal(caller.account, caller.accessToken, input));
  });

  registerRequestRoutes(app, workflow, 'DEPOSIT', '/v1/lp/deposit');
  registerRequestRoutes(app, workflow, 'WITHDRAW', '/v1/lp/withdraw');

  app.get('/v1/lp/positions', async (request, reply) => {
    const caller = requireCaller(request);
    return sendJson(reply, 200, await workflow.positions(caller.account, caller.accessToken));
  });
}
