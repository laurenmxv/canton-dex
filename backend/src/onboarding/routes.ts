import type { FastifyInstance } from 'fastify';
import { requireCaller } from '../iam/authentication.js';
import { sendJson } from '../platform/problems.js';
import { pathUuid, readJsonObject } from '../platform/request.js';
import { onboardingApplication, partyKey, partySubmission, reviewDecision } from './requests.js';
import type { OnboardingStore } from './store.js';
import type { OnboardingWorkflow } from './workflow.js';

interface OnboardingParams {
  readonly onboardingId: string;
}

/** The onboarding routes and the public pool list. Handlers parse the path before the body. */
export function registerOnboardingRoutes(
  app: FastifyInstance,
  store: OnboardingStore,
  workflow: OnboardingWorkflow,
): void {
  app.get('/v1/pools', async (_request, reply) => sendJson(reply, 200, await store.pools()));

  app.get('/v1/onboardings/mine', async (request, reply) => {
    const caller = requireCaller(request);
    return sendJson(reply, 200, await workflow.mine(caller.account, caller.accessToken));
  });

  app.post('/v1/onboardings', async (request, reply) => {
    const application = onboardingApplication(readJsonObject(request));
    const onboarding = await store.create(requireCaller(request).account, application);
    return sendJson(reply.header('location', `/v1/onboardings/${onboarding.id}`), 201, onboarding);
  });

  app.get<{ Params: OnboardingParams }>('/v1/onboardings/:onboardingId', async (request, reply) => {
    const id = pathUuid(request.params.onboardingId);
    const caller = requireCaller(request);
    return sendJson(reply, 200, await workflow.getOwned(id, caller.account, caller.accessToken));
  });

  app.get('/v1/admin/onboardings', async (_request, reply) => sendJson(reply, 200, await store.list()));

  app.post<{ Params: OnboardingParams }>('/v1/admin/onboardings/:onboardingId/review', async (request, reply) => {
    const id = pathUuid(request.params.onboardingId);
    const caller = requireCaller(request);
    const decision = reviewDecision(readJsonObject(request));
    return sendJson(reply, 200, await workflow.review(id, caller.account, decision, caller.accessToken));
  });

  app.post<{ Params: OnboardingParams }>('/v1/onboardings/:onboardingId/party/prepare', async (request, reply) => {
    const id = pathUuid(request.params.onboardingId);
    const caller = requireCaller(request);
    const key = partyKey(readJsonObject(request));
    return sendJson(reply, 200, await store.prepare(id, caller.account, key, caller.accessToken));
  });

  app.post<{ Params: OnboardingParams }>('/v1/onboardings/:onboardingId/party/submit', async (request, reply) => {
    const id = pathUuid(request.params.onboardingId);
    const caller = requireCaller(request);
    const submission = partySubmission(readJsonObject(request));
    return sendJson(reply, 200, await workflow.submitParty(id, caller.account, submission, caller.accessToken));
  });
}
