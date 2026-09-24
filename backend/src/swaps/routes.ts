import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireCaller } from '../iam/authentication.js';
import { sendJson } from '../platform/problems.js';
import { pathUuid, readJsonObject } from '../platform/request.js';
import { prepareInput, quoteInput, submission } from './requests.js';
import type { SwapWorkflow } from './workflow.js';

function swapId(request: FastifyRequest<{ Params: { swapId: string } }>): string {
  return pathUuid(request.params.swapId);
}

export function registerSwapRoutes(app: FastifyInstance, workflow: SwapWorkflow): void {
  app.post('/v1/swaps/quote', async (request, reply) => {
    const caller = requireCaller(request);
    const input = quoteInput(readJsonObject(request));
    return sendJson(reply, 200, await workflow.quote(caller.account, caller.accessToken, input));
  });

  app.post('/v1/swaps/prepare', async (request, reply) => {
    const caller = requireCaller(request);
    const input = prepareInput(readJsonObject(request));
    return sendJson(reply, 200, await workflow.prepare(caller.account, caller.accessToken, input));
  });

  app.post('/v1/swaps/submit', async (request, reply) => {
    const caller = requireCaller(request);
    const input = submission(readJsonObject(request));
    return sendJson(reply, 202, await workflow.submit(caller.account, caller.accessToken, input));
  });

  app.get<{ Params: { swapId: string } }>('/v1/swaps/:swapId', async (request, reply) =>
    sendJson(reply, 200, await workflow.get(swapId(request), requireCaller(request).account)),
  );

  app.post<{ Params: { swapId: string } }>('/v1/swaps/:swapId/cancel/prepare', async (request, reply) => {
    const id = swapId(request);
    const caller = requireCaller(request);
    return sendJson(reply, 200, await workflow.prepareWithdrawal(id, caller.account, caller.accessToken));
  });

  app.post<{ Params: { swapId: string } }>('/v1/swaps/:swapId/cancel/submit', async (request, reply) => {
    const id = swapId(request);
    const caller = requireCaller(request);
    const input = submission(readJsonObject(request));
    return sendJson(reply, 202, await workflow.withdraw(id, caller.account, caller.accessToken, input));
  });
}
