/**
 * Exact off-ledger market data derived from confirmed swap settlements.
 *
 * @packageDocumentation
 */
import type { PoolDetail } from '../pools/model.js';
import { divideHalfUp, numericUnits, trimmedText } from '../platform/decimal.js';
import { epochNanos, instantText, NANOS_PER_SECOND } from '../platform/time.js';
import type { Direction } from '../swaps/model.js';

const HOUR_NANOS = 3_600n * NANOS_PER_SECOND;

export interface TradeEvidence {
  readonly swapId: string;
  readonly direction: Direction;
  readonly amountIn: string;
  readonly amountOut: string;
  readonly settledAt: string;
}

export interface MarketTrade {
  readonly swapId: string;
  readonly direction: Direction;
  readonly baseAmount: string;
  readonly quoteAmount: string;
  /** Quote units paid per base unit, rounded half away from zero at Numeric 10 precision. */
  readonly executionPrice: string;
  readonly settledAt: string;
}

export interface MarketCandle {
  /** Inclusive UTC hour boundary. Empty hours are omitted. */
  readonly startedAt: string;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly baseVolume: string;
  readonly quoteVolume: string;
  readonly tradeCount: number;
}

export interface MarketData {
  readonly poolId: string;
  readonly asOf: string;
  readonly interval: '1h';
  readonly spotPrice: string | null;
  readonly baseVolume24h: string;
  readonly quoteVolume24h: string;
  /** Signed percentage change, not a ratio. Null until two boundary trades exist. */
  readonly priceChangePercent24h: string | null;
  readonly candles: readonly MarketCandle[];
  readonly recentTrades: readonly MarketTrade[];
}

interface MutableCandle {
  startedAt: string;
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
  baseVolume: bigint;
  quoteVolume: bigint;
  tradeCount: number;
}

function tradeOf(evidence: TradeEvidence): MarketTrade {
  const baseAmount = evidence.direction === 'BaseToQuote' ? evidence.amountIn : evidence.amountOut;
  const quoteAmount = evidence.direction === 'BaseToQuote' ? evidence.amountOut : evidence.amountIn;
  const base = numericUnits(baseAmount);
  const quote = numericUnits(quoteAmount);
  if (base <= 0n || quote <= 0n) throw new Error('A confirmed swap has a non-positive fill');
  return {
    swapId: evidence.swapId,
    direction: evidence.direction,
    baseAmount,
    quoteAmount,
    executionPrice: trimmedText(divideHalfUp(quote, base)),
    settledAt: evidence.settledAt,
  };
}

function candleOf(candle: MutableCandle): MarketCandle {
  return {
    startedAt: candle.startedAt,
    open: trimmedText(candle.open),
    high: trimmedText(candle.high),
    low: trimmedText(candle.low),
    close: trimmedText(candle.close),
    baseVolume: trimmedText(candle.baseVolume),
    quoteVolume: trimmedText(candle.quoteVolume),
    tradeCount: candle.tradeCount,
  };
}

/** Builds sparse UTC-hour candles and a summary from one exact 24-hour evidence window. */
export function marketData(
  pool: PoolDetail,
  evidence: readonly TradeEvidence[],
  asOf: bigint,
  candleLimit: number,
  recentLimit: number,
): MarketData {
  const trades = evidence
    .map(tradeOf)
    .sort((left, right) => {
      const time = epochNanos(left.settledAt) - epochNanos(right.settledAt);
      return time < 0n ? -1 : time > 0n ? 1 : left.swapId.localeCompare(right.swapId);
    });

  let baseVolume = 0n;
  let quoteVolume = 0n;
  const candles = new Map<bigint, MutableCandle>();
  for (const trade of trades) {
    const base = numericUnits(trade.baseAmount);
    const quote = numericUnits(trade.quoteAmount);
    const price = numericUnits(trade.executionPrice);
    baseVolume += base;
    quoteVolume += quote;
    const bucket = (epochNanos(trade.settledAt) / HOUR_NANOS) * HOUR_NANOS;
    const current = candles.get(bucket);
    if (current) {
      current.high = current.high > price ? current.high : price;
      current.low = current.low < price ? current.low : price;
      current.close = price;
      current.baseVolume += base;
      current.quoteVolume += quote;
      current.tradeCount += 1;
    } else {
      candles.set(bucket, {
        startedAt: instantText(bucket),
        open: price,
        high: price,
        low: price,
        close: price,
        baseVolume: base,
        quoteVolume: quote,
        tradeCount: 1,
      });
    }
  }

  const baseReserve = numericUnits(pool.settings.baseReserve);
  const quoteReserve = numericUnits(pool.settings.quoteReserve);
  const first = trades[0];
  const last = trades.at(-1);
  const firstPrice = first ? numericUnits(first.executionPrice) : null;
  const lastPrice = last ? numericUnits(last.executionPrice) : null;
  const priceChange =
    trades.length < 2 || firstPrice === null || firstPrice === 0n || lastPrice === null
      ? null
      : trimmedText(divideHalfUp((lastPrice - firstPrice) * 100n, firstPrice));

  return {
    poolId: pool.poolId,
    asOf: instantText(asOf),
    interval: '1h',
    spotPrice:
      baseReserve <= 0n || quoteReserve <= 0n ? null : trimmedText(divideHalfUp(quoteReserve, baseReserve)),
    baseVolume24h: trimmedText(baseVolume),
    quoteVolume24h: trimmedText(quoteVolume),
    priceChangePercent24h: priceChange,
    candles: [...candles.values()].slice(-candleLimit).map(candleOf),
    recentTrades: trades.slice(-recentLimit).reverse(),
  };
}
