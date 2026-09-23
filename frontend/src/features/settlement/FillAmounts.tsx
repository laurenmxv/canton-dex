import type { SettlementFill } from '../../lib/api/types';
import { formatExact } from '../../lib/decimal';

/** This pool's base and quote instruments. Its LP reads "LP", as it does in the queue. */
export interface PoolLabels {
  baseLabel: string;
  quoteLabel: string;
}

/**
 * What one fill moves, in the pool's own instruments.
 *
 * A fill is a payment only once its batch is confirmed. The caller says which
 * it is: a projection and a settled fill share this shape.
 */
export function FillAmounts({ fill, baseLabel, quoteLabel }: PoolLabels & { fill: SettlementFill }) {
  switch (fill.type) {
    case 'swap':
      return <>{`${formatExact(fill.amountOut)} ${fill.outputInstrument.id}`}</>;
    case 'deposit':
      return (
        <>
          {formatExact(fill.actualLpOut)} LP for {formatExact(fill.actualBaseIn)} {baseLabel} +{' '}
          {formatExact(fill.actualQuoteIn)} {quoteLabel}
          <span className="text-muted-foreground block text-xs">
            refunded {formatExact(fill.actualBaseRefund)} {baseLabel} +{' '}
            {formatExact(fill.actualQuoteRefund)} {quoteLabel}
          </span>
        </>
      );
    case 'withdraw':
      return (
        <>
          {formatExact(fill.actualBaseOut)} {baseLabel} + {formatExact(fill.actualQuoteOut)}{' '}
          {quoteLabel} for {formatExact(fill.actualLpBurned)} LP
        </>
      );
  }
}
