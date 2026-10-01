import type { FastifyInstance } from 'fastify';
import { InvalidRequest } from '../platform/errors.js';
import type { MarketWorkflow } from './workflow.js';

const DEFAULT_CANDLES = 24;
const DEFAULT_TRADES = 20;

function bounded(raw: unknown, fallback: number, maximum: number, name: string): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) {
    throw new InvalidRequest(`${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new InvalidRequest(`${name} must be at most ${String(maximum)}`);
  }
  return value;
}

export function registerMarketRoutes(app: FastifyInstance, workflow: MarketWorkflow): void {
  app.get<{
    Params: { poolId: string };
    Querystring: { interval?: string; candleLimit?: string; recentLimit?: string };
  }>('/v1/pools/:poolId/market-data', async (request) => {
    if (request.query.interval !== undefined && request.query.interval !== '1h') {
      throw new InvalidRequest('interval must be 1h');
    }
    const candleLimit = bounded(request.query.candleLimit, DEFAULT_CANDLES, 24, 'candleLimit');
    const recentLimit = bounded(request.query.recentLimit, DEFAULT_TRADES, 20, 'recentLimit');
    return workflow.get(request.params.poolId, { candleLimit, recentLimit });
  });
}
