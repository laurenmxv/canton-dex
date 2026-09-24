import type { FastifyInstance } from 'fastify';
import { requireRole, type Account } from '../iam/accounts.js';
import { requireCaller } from '../iam/authentication.js';
import { LIQUIDITY_STATUSES } from '../liquidity/model.js';
import type { LiquidityHistory } from '../liquidity/ports.js';
import type { LiquidityWorkflow } from '../liquidity/workflow.js';
import { InvalidRequest } from '../platform/errors.js';
import { sendJson } from '../platform/problems.js';
import { parseInt32, pathUuid, queryParam, requirePageSize } from '../platform/request.js';
import { epochNanos } from '../platform/time.js';
import { liquidityRequest, requestId, swapRequest, type QueueRequest } from '../settlements/model.js';
import { SWAP_STATUSES, type Before } from '../swaps/model.js';
import type { SwapHistory } from '../swaps/ports.js';
import type { SwapWorkflow } from '../swaps/workflow.js';

const DEFAULT_LIMIT = '50';

export interface ActivitySources {
  readonly swaps: SwapWorkflow;
  readonly liquidity: LiquidityWorkflow;
  readonly swapHistory: SwapHistory;
  readonly liquidityHistory: LiquidityHistory;
}

export interface AllActivity {
  readonly items: readonly QueueRequest[];
  readonly nextCursor: string | null;
}

function createdAt(item: QueueRequest): string {
  return item.request.createdAt;
}

/** Newest first; equal creation times order by descending request id. */
function newestFirst(left: QueueRequest, right: QueueRequest): number {
  const time = epochNanos(createdAt(right)) - epochNanos(createdAt(left));
  if (time !== 0n) return time < 0n ? -1 : 1;
  const [a, b] = [requestId(left), requestId(right)];
  return a === b ? 0 : a < b ? 1 : -1;
}

/**
 * Every request kind in one page. The cursor is `<type>:<requestId>` of the last item; each
 * source reads below that item's creation time and id.
 */
async function allActivity(
  sources: ActivitySources,
  caller: Account,
  limit: number,
  cursor: string | null,
  status: string | null,
): Promise<AllActivity> {
  requirePageSize(limit);
  if (status !== null && ![...SWAP_STATUSES, ...LIQUIDITY_STATUSES].some((name) => name === status)) {
    throw new InvalidRequest('Unknown status');
  }
  let before: Before | null = null;
  if (cursor !== null) {
    const separator = cursor.indexOf(':');
    if (separator < 0) throw new InvalidRequest('Invalid activity cursor');
    const type = cursor.slice(0, separator);
    const id = pathUuid(cursor.slice(separator + 1));
    if (type === 'swap') {
      before = { createdAt: (await sources.swapHistory.owned(id, caller)).createdAt, id };
    } else {
      const prior = await sources.liquidityHistory.owned(id, caller);
      if (type !== (prior.kind === 'DEPOSIT' ? 'deposit' : 'withdraw'))
        throw new InvalidRequest('Invalid activity cursor');
      before = { createdAt: prior.createdAt, id };
    }
  }
  const swapPage = await sources.swapHistory.activityBefore(caller, limit, before, status);
  const liquidityPage = await sources.liquidityHistory.activityBefore(caller, null, limit, before, status);
  const combined = [
    ...swapPage.items.map((item) => swapRequest(item)),
    ...liquidityPage.items.map((item) => liquidityRequest(item)),
  ].sort(newestFirst);
  const more = combined.length > limit || swapPage.nextCursor !== null || liquidityPage.nextCursor !== null;
  const items = combined.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: more && last ? `${last.type}:${requestId(last)}` : null };
}

/** GET /v1/activity: one kind's history, or every kind with `type=all`. */
export function registerActivityRoutes(app: FastifyInstance, sources: ActivitySources): void {
  app.get('/v1/activity', async (request, reply) => {
    const caller = requireCaller(request).account;
    requireRole(caller, 'TRADER');
    const type = queryParam(request, 'type') ?? 'swap';
    const limit = parseInt32(queryParam(request, 'limit') ?? DEFAULT_LIMIT);
    const cursor = queryParam(request, 'cursor');
    const status = queryParam(request, 'status');
    switch (type) {
      case 'swap':
        return sendJson(reply, 200, await sources.swaps.activity(caller, limit, cursor, status));
      case 'deposit':
        return sendJson(reply, 200, await sources.liquidity.activity(caller, 'DEPOSIT', limit, cursor, status));
      case 'withdraw':
        return sendJson(reply, 200, await sources.liquidity.activity(caller, 'WITHDRAW', limit, cursor, status));
      case 'all':
        return sendJson(reply, 200, await allActivity(sources, caller, limit, cursor, status));
      default:
        throw new InvalidRequest('Unknown activity type');
    }
  });
}
