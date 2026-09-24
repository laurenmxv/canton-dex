import { InvalidRequest } from '../platform/errors.js';
import { enumeration, instant, int, notBlank, text, uuid, type JsonObject } from '../platform/request.js';
import { DIRECTIONS, MAX_SLIPPAGE_BPS, type PrepareInput, type QuoteInput, type Submission } from './model.js';

/** A body that fails validation; every such failure is the generic 400 answer. */
export function invalidBody(): InvalidRequest {
  return new InvalidRequest('Invalid request fields or request body');
}

/** A primitive `int` field: missing or null is 0. */
export function slippage(value: unknown): number {
  const bps = int(value) ?? 0;
  if (bps < 0 || bps > MAX_SLIPPAGE_BPS) throw invalidBody();
  return bps;
}

/** POST /v1/swaps/quote. */
export function quoteInput(body: JsonObject): QuoteInput {
  const poolId = text(body.poolId);
  const direction = enumeration(body.direction, DIRECTIONS);
  const amountIn = text(body.amountIn);
  const slippageBps = slippage(body.slippageBps);
  if (!notBlank(poolId) || direction === null || !notBlank(amountIn)) throw invalidBody();
  return { poolId, direction, amountIn, slippageBps };
}

/** POST /v1/swaps/prepare. */
export function prepareInput(body: JsonObject): PrepareInput {
  const quoteId = uuid(body.quoteId);
  const minOut = text(body.minOut);
  const settlementDeadline = instant(body.settlementDeadline);
  if (quoteId === null || !notBlank(minOut) || settlementDeadline === null) throw invalidBody();
  return { quoteId, minOut, settlementDeadline };
}

/** The signed-preparation bodies of every submit and cancel route. */
export function submission(body: JsonObject): Submission {
  const preparationId = uuid(body.preparationId);
  const signature = text(body.signature);
  if (preparationId === null || !notBlank(signature)) throw invalidBody();
  return { preparationId, signature };
}
