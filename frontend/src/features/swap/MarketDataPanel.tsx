import { Button } from '@openzeppelin/ui-components';
import type { AsyncResult } from '../../app/useAsync';
import type { MarketCandle, MarketData } from '../../lib/api/types';
import {
  compareDecimals,
  decimalRatio,
  formatExact,
  parseDecimal,
  subtractDecimals,
  type Decimal,
} from '../../lib/decimal';
import { formatDateTime } from '../../lib/labels';
import { Card, CardHeader, DataList } from '../../ui/Card';
import { EmptyState, ErrorState, Loading, RefreshFailure } from '../../ui/States';

function price(text: string, quote: string, base: string): string {
  return `${formatExact(text)} ${quote} / ${base}`;
}

function change(text: string | null): string {
  if (text === null) return 'Not enough trades';
  return `${text.startsWith('-') ? '' : '+'}${formatExact(text)}%`;
}

function candleBounds(candles: readonly MarketCandle[]): { low: Decimal; high: Decimal } | null {
  const values = candles.flatMap((candle) => [parseDecimal(candle.low), parseDecimal(candle.high)]);
  if (values.some((value) => value === null)) return null;
  const present = values as Decimal[];
  if (present.length === 0) return null;
  return {
    low: present.reduce((lowest, value) => (compareDecimals(value, lowest) < 0 ? value : lowest)),
    high: present.reduce((highest, value) => (compareDecimals(value, highest) > 0 ? value : highest)),
  };
}

/** Turns an exact price into a plotting coordinate. The returned number is never financial data. */
function plotY(value: string, low: Decimal, span: Decimal, height: number): number | null {
  const parsed = parseDecimal(value);
  if (!parsed) return null;
  const ratio = decimalRatio(subtractDecimals(parsed, low), span);
  return ratio === null ? height / 2 : height - ratio * height;
}

function CandleChart({
  candles,
  base,
  quote,
}: {
  candles: readonly MarketCandle[];
  base: string;
  quote: string;
}) {
  const bounds = candleBounds(candles);
  if (!bounds) return null;
  const width = 720;
  const height = 180;
  const span = subtractDecimals(bounds.high, bounds.low);
  const step = width / candles.length;
  const bodyWidth = Math.max(3, Math.min(18, step * 0.55));

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="block h-auto max-h-52 w-full"
      role="img"
      aria-label={`Hourly ${base} price in ${quote}; ${candles.length} non-empty hours`}
    >
      {candles.map((candle, index) => {
        const open = plotY(candle.open, bounds.low, span, height);
        const close = plotY(candle.close, bounds.low, span, height);
        const high = plotY(candle.high, bounds.low, span, height);
        const low = plotY(candle.low, bounds.low, span, height);
        if (open === null || close === null || high === null || low === null) return null;
        const x = step * index + step / 2;
        const rising = compareDecimals(parseDecimal(candle.close)!, parseDecimal(candle.open)!) >= 0;
        const color = rising ? 'var(--success)' : 'var(--destructive)';
        return (
          <g key={candle.startedAt}>
            <title>
              {formatDateTime(candle.startedAt)}: open {candle.open}, high {candle.high}, low{' '}
              {candle.low}, close {candle.close} {quote} per {base}
            </title>
            <line x1={x} x2={x} y1={high} y2={low} stroke={color} strokeWidth="1.5" />
            <rect
              x={x - bodyWidth / 2}
              y={Math.min(open, close)}
              width={bodyWidth}
              height={Math.max(2, Math.abs(close - open))}
              fill={color}
              rx="1"
            />
          </g>
        );
      })}
    </svg>
  );
}

export function MarketDataPanel({
  market,
  base,
  quote,
}: {
  market: AsyncResult<MarketData>;
  base: string;
  quote: string;
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Market data"
        description="Current reserves and confirmed swaps from the rolling last 24 hours"
        actions={
          <Button variant="secondary" size="sm" onClick={market.reload} disabled={market.loading}>
            Refresh
          </Button>
        }
      />
      <div className="flex flex-col gap-5 p-5">
        {market.loading && market.data === undefined ? <Loading label="Loading market data" /> : null}
        {market.error && market.data === undefined ? (
          <ErrorState error={market.error} onRetry={market.reload} />
        ) : null}
        {market.error && market.data !== undefined ? (
          <RefreshFailure error={market.error} onRetry={market.reload} />
        ) : null}
        {market.data ? (
          <>
            <DataList
              items={[
                {
                  label: 'Spot price',
                  value:
                    market.data.spotPrice === null
                      ? 'Unavailable until the pool has liquidity'
                      : price(market.data.spotPrice, quote, base),
                },
                { label: '24h change', value: change(market.data.priceChangePercent24h) },
                {
                  label: '24h base volume',
                  value: `${formatExact(market.data.baseVolume24h)} ${base}`,
                },
                {
                  label: '24h quote volume',
                  value: `${formatExact(market.data.quoteVolume24h)} ${quote}`,
                },
              ]}
            />

            {market.data.candles.length === 0 ? (
              <EmptyState title="No confirmed trades in the last 24 hours" />
            ) : (
              <div className="flex flex-col gap-3">
                <CandleChart candles={market.data.candles} base={base} quote={quote} />
                <details className="text-xs">
                  <summary className="cursor-pointer font-medium">Hourly OHLC details</summary>
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full min-w-[42rem] text-left">
                      <thead className="text-muted-foreground">
                        <tr>
                          <th className="py-2 pr-4 font-medium">UTC hour</th>
                          {['Open', 'High', 'Low', 'Close', `Volume ${base}`].map((label) => (
                            <th key={label} className="px-2 py-2 text-right font-medium">
                              {label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {market.data.candles.map((candle) => (
                          <tr key={candle.startedAt} className="border-t">
                            <td className="py-2 pr-4">{formatDateTime(candle.startedAt)}</td>
                            {[candle.open, candle.high, candle.low, candle.close, candle.baseVolume].map(
                              (value, index) => (
                                <td key={index} className="px-2 py-2 text-right tabular-nums">
                                  {formatExact(value)}
                                </td>
                              ),
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </div>
            )}

            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">Recent confirmed trades</h3>
              {market.data.recentTrades.length === 0 ? (
                <p className="text-muted-foreground text-sm">No trades to show yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[38rem] text-left text-sm">
                    <thead className="text-muted-foreground text-xs">
                      <tr>
                        <th className="py-2 pr-4 font-medium">Settlement time</th>
                        <th className="px-2 py-2 font-medium">Direction</th>
                        <th className="px-2 py-2 text-right font-medium">Base</th>
                        <th className="px-2 py-2 text-right font-medium">Quote</th>
                        <th className="pl-2 py-2 text-right font-medium">Price</th>
                      </tr>
                    </thead>
                    <tbody>
                      {market.data.recentTrades.map((trade) => (
                        <tr key={trade.swapId} className="border-t">
                          <td className="py-2 pr-4">{formatDateTime(trade.settledAt)}</td>
                          <td className="px-2 py-2">
                            {trade.direction === 'BaseToQuote'
                              ? `${base} → ${quote}`
                              : `${quote} → ${base}`}
                          </td>
                          <td className="px-2 py-2 text-right tabular-nums">
                            {formatExact(trade.baseAmount)} {base}
                          </td>
                          <td className="px-2 py-2 text-right tabular-nums">
                            {formatExact(trade.quoteAmount)} {quote}
                          </td>
                          <td className="pl-2 py-2 text-right tabular-nums">
                            {price(trade.executionPrice, quote, base)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <p className="text-muted-foreground text-xs">
              Confirmed settlements only · as of {formatDateTime(market.data.asOf)}
            </p>
          </>
        ) : null}
      </div>
    </Card>
  );
}
