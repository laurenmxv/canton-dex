import { describe, expect, it } from 'vitest';
import type { PoolDetail } from '../pools/model.js';
import { epochNanos } from '../platform/time.js';
import { marketData, type TradeEvidence } from './model.js';

const POOL: PoolDetail = {
  poolId: 'pool-1',
  name: 'BTC / USDC',
  settings: {
    dvo: 'dvo',
    baseInstrumentId: { admin: 'issuer', id: 'BTC' },
    quoteInstrumentId: { admin: 'issuer', id: 'USDC' },
    baseAccount: { owner: 'dvo', provider: 'operator', id: 'base' },
    quoteAccount: { owner: 'dvo', provider: 'operator', id: 'quote' },
    lpTokenInstrumentId: { admin: 'dvo', id: 'LP' },
    feeBps: '30',
    baseReserve: '3',
    quoteReserve: '180000',
    lpTokenSupply: '100',
    initialRatio: '60000',
  },
  configId: 'config',
  stateId: 'state',
  packageId: 'package',
  createdAt: '2026-09-30T00:00:00Z',
  updatedAt: '2026-10-01T12:00:00Z',
};

const TRADES: TradeEvidence[] = [
  {
    swapId: 'later',
    direction: 'QuoteToBase',
    amountIn: '62000',
    amountOut: '1',
    settledAt: '2026-10-01T11:05:00Z',
  },
  {
    swapId: 'first',
    direction: 'BaseToQuote',
    amountIn: '2',
    amountOut: '120000',
    settledAt: '2026-10-01T10:05:00Z',
  },
  {
    swapId: 'same-hour',
    direction: 'BaseToQuote',
    amountIn: '0.5',
    amountOut: '30500',
    settledAt: '2026-10-01T10:40:00Z',
  },
];

describe('market data arithmetic', () => {
  it('normalizes both directions without JavaScript floating-point arithmetic', () => {
    const result = marketData(POOL, TRADES, epochNanos('2026-10-01T12:00:00Z'), 24, 20);

    expect(result.spotPrice).toBe('60000');
    expect(result.baseVolume24h).toBe('3.5');
    expect(result.quoteVolume24h).toBe('212500');
    expect(result.priceChangePercent24h).toBe('3.3333333333');
    expect(result.recentTrades.map((trade) => trade.swapId)).toEqual([
      'later',
      'same-hour',
      'first',
    ]);
    expect(result.recentTrades[0]).toMatchObject({
      direction: 'QuoteToBase',
      baseAmount: '1',
      quoteAmount: '62000',
      executionPrice: '62000',
    });
  });

  it('makes sparse ascending UTC candles with exact OHLC and volume', () => {
    const result = marketData(POOL, TRADES, epochNanos('2026-10-01T12:00:00Z'), 24, 20);

    expect(result.candles).toEqual([
      {
        startedAt: '2026-10-01T10:00:00Z',
        open: '60000',
        high: '61000',
        low: '60000',
        close: '61000',
        baseVolume: '2.5',
        quoteVolume: '150500',
        tradeCount: 2,
      },
      {
        startedAt: '2026-10-01T11:00:00Z',
        open: '62000',
        high: '62000',
        low: '62000',
        close: '62000',
        baseVolume: '1',
        quoteVolume: '62000',
        tradeCount: 1,
      },
    ]);
  });

  it('reports the defined empty and one-trade boundaries', () => {
    const emptyPool = {
      ...POOL,
      settings: { ...POOL.settings, baseReserve: '0', quoteReserve: '0' },
    };
    const empty = marketData(emptyPool, [], epochNanos('2026-10-01T12:00:00Z'), 24, 20);
    expect(empty).toMatchObject({
      spotPrice: null,
      baseVolume24h: '0',
      quoteVolume24h: '0',
      priceChangePercent24h: null,
      candles: [],
      recentTrades: [],
    });

    const one = marketData(POOL, TRADES.slice(0, 1), epochNanos('2026-10-01T12:00:00Z'), 24, 20);
    expect(one.priceChangePercent24h).toBeNull();
  });

  it('applies the two response limits after constructing the full window', () => {
    const result = marketData(POOL, TRADES, epochNanos('2026-10-01T12:00:00Z'), 1, 2);
    expect(result.candles.map((candle) => candle.startedAt)).toEqual(['2026-10-01T11:00:00Z']);
    expect(result.recentTrades.map((trade) => trade.swapId)).toEqual(['later', 'same-hour']);
    expect(result.baseVolume24h).toBe('3.5');
  });
});
