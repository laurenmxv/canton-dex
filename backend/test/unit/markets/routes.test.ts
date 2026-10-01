import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerMarketRoutes } from '../../../src/markets/routes.js';
import type { MarketWorkflow } from '../../../src/markets/workflow.js';
import { createServer } from '../../../src/platform/server.js';

describe('pool market-data route', () => {
  const get = vi.fn(() =>
    Promise.resolve({
      poolId: 'pool',
      asOf: '2026-10-01T12:00:00Z',
      interval: '1h' as const,
      spotPrice: '60000',
      baseVolume24h: '1',
      quoteVolume24h: '60000',
      priceChangePercent24h: null,
      candles: [],
      recentTrades: [],
    }),
  );
  let app: FastifyInstance;

  beforeEach(() => {
    get.mockClear();
    app = createServer();
    registerMarketRoutes(app, { get } as unknown as MarketWorkflow);
  });

  afterEach(() => app.close());

  it('uses the bounded public defaults', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/pools/pool/market-data' });
    expect(response.statusCode).toBe(200);
    expect(get).toHaveBeenCalledWith('pool', { candleLimit: 24, recentLimit: 20 });
  });

  it('passes supported interval and limits', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/pools/pool/market-data?interval=1h&candleLimit=4&recentLimit=7',
    });
    expect(response.statusCode).toBe(200);
    expect(get).toHaveBeenCalledWith('pool', { candleLimit: 4, recentLimit: 7 });
  });

  it.each([
    'interval=5m',
    'candleLimit=0',
    'candleLimit=25',
    'recentLimit=1.5',
    'recentLimit=21',
  ])('rejects unsupported query %s before reading history', async (query) => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/pools/pool/market-data?${query}`,
    });
    expect(response.statusCode).toBe(400);
    expect(get).not.toHaveBeenCalled();
  });
});
