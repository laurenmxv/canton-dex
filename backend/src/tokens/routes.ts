import type { FastifyInstance } from 'fastify';
import { requireCaller } from '../iam/authentication.js';
import { sendJson } from '../platform/problems.js';
import { readJsonObject } from '../platform/request.js';
import { faucetSubmission } from './requests.js';
import type { TokenWorkflow } from './workflow.js';

/** The balance route, and the development faucet routes when development tokens are enabled. */
export function registerTokenRoutes(app: FastifyInstance, workflow: TokenWorkflow, faucetEnabled: boolean): void {
  app.get('/v1/balances', async (request, reply) => {
    const caller = requireCaller(request);
    return sendJson(reply, 200, await workflow.balances(caller.account, caller.accessToken));
  });
  if (!faucetEnabled) return;

  app.get('/v1/dev/faucet', async (request, reply) =>
    sendJson(reply, 200, await workflow.status(requireCaller(request).account)),
  );

  app.post('/v1/dev/faucet/prepare', async (request, reply) => {
    const caller = requireCaller(request);
    return sendJson(reply, 200, await workflow.prepare(caller.account, caller.accessToken));
  });

  app.post('/v1/dev/faucet/submit', async (request, reply) => {
    const submission = faucetSubmission(readJsonObject(request));
    const caller = requireCaller(request);
    return sendJson(reply, 202, await workflow.submit(caller.account, caller.accessToken, submission));
  });
}
