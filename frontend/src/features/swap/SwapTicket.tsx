import { useState } from 'react';
import { useDexClient } from '../../app/runtime';
import { useAction, type AsyncResult } from '../../app/useAsync';
import { useNow } from '../../app/useNow';
import { MAX_SLIPPAGE_BPS, venueErrorCode } from '../../lib/api/types';
import type {
  PoolDetail,
  PoolSummary,
  Swap,
  SwapDirection,
  SwapQuoteRecord,
  TokenBalances,
} from '../../lib/api/types';
import { formatDecimal, formatExact } from '../../lib/decimal';
import { directionLabel, formatCountdown, formatDateTime, formatFeeBps } from '../../lib/labels';
import { Callout } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card, CardHeader, DataList } from '../../ui/Card';
import { SelectField, TextField } from '../../ui/Field';
import { ErrorState, Loading } from '../../ui/States';
import { walletMessage, type WalletSigner } from '../wallet/signing';
import { amountProblem, balanceOf, instrumentLabel, sidesOf, slippageProblem } from './terms';

/**
 * One swap, from a price to a signed request.
 *
 * The venue prices it, the trader's wallet signs the terms, and the venue
 * submits the transaction unchanged. Nothing here computes an output, and the
 * acknowledgement says the request is queued, because that is all it is: the
 * pool settles it later, in a batch, at the reserves that hold then.
 */
export function SwapTicket({
  pools,
  pool,
  poolId,
  onPoolId,
  balances,
  signer,
  onDispatched,
  unresolvedSwapId,
  onSubmitted,
}: {
  pools: readonly PoolSummary[];
  /** The selected pool's own terms. Absent while they are being read. */
  pool: AsyncResult<PoolDetail>;
  poolId: string;
  onPoolId: (poolId: string) => void;
  balances: AsyncResult<TokenBalances>;
  signer: WalletSigner;
  /**
   * Called once a request is the venue's to report on: when a signature has
   * left, or when the venue says an earlier one already exists. The id is
   * absent where only the venue knows it.
   */
  onDispatched: (swapId: string | undefined) => void;
  /** A request of this trader's that was sent and is not yet accounted for. */
  unresolvedSwapId: string | undefined;
  onSubmitted: (swap: Swap) => void;
}) {
  const client = useDexClient();
  const [direction, setDirection] = useState<SwapDirection>('BaseToQuote');
  const [amountIn, setAmountIn] = useState('');
  const [slippageBps, setSlippageBps] = useState('50');
  const [touched, setTouched] = useState(false);
  const [quote, setQuote] = useState<SwapQuoteRecord>();
  const [submitted, setSubmitted] = useState<Swap>();
  /** True once the venue has refused to prepare this quote again. */
  const [stale, setStale] = useState(false);
  // Whether a request is still unaccounted for is the history's answer, not
  // this form's, so it comes back down rather than being tracked twice.
  const unresolved = unresolvedSwapId;

  const held = balances.data?.balances ?? [];
  const baseSymbol = pool.data ? instrumentLabel(held, pool.data.settings.baseInstrumentId) : '';
  const quoteSymbol = pool.data ? instrumentLabel(held, pool.data.settings.quoteInstrumentId) : '';
  const sides = pool.data ? sidesOf(pool.data, direction) : undefined;
  const inSymbol = sides ? instrumentLabel(held, sides.input) : '';
  const outSymbol = sides ? instrumentLabel(held, sides.output) : '';
  const inputBalance = sides ? balanceOf(held, sides.input) : undefined;

  const requestQuote = useAction(() =>
    client.swaps.quote({
      poolId,
      direction,
      amountIn: amountIn.trim(),
      slippageBps: Number(slippageBps.trim()),
    }),
  );

  /**
   * Prepare, sign and submit, in that order.
   *
   * Preparing the same quote on the same terms answers with the preparation
   * that already exists, so a dismissed wallet prompt is retried from here
   * without a second request ever being created.
   *
   * Once the signature has left, the request exists whatever this browser
   * hears back. A lost reply is an unknown outcome, not a failure: it is
   * handed up for recovery rather than offered as something to sign again.
   */
  const requestSwap = useAction(async (approved: SwapQuoteRecord) => {
    let prepared;
    try {
      prepared = await client.swaps.prepare({
        quoteId: approved.quoteId,
        minOut: approved.minOut,
        settlementDeadline: approved.settlementDeadline,
      });
    } catch (cause) {
      // The venue still holds an earlier preparation for this quote whose
      // signing window has closed. The request it belongs to may already be on
      // the ledger, so it is read back rather than replaced.
      if (venueErrorCode(cause) === 'PREPARATION_EXPIRED') {
        setStale(true);
        onDispatched(undefined);
      }
      throw cause;
    }
    const signature = await signer.sign(prepared, {
      operation: 'Swap',
      tokenSymbol: `${inSymbol} to ${outSymbol}`,
      amount: `${prepared.terms.amountIn} ${inSymbol} for at least ${prepared.terms.minOut} ${outSymbol}`,
      recipient: prepared.terms.poolName,
      sender: prepared.terms.trader,
    });
    try {
      return await client.swaps.submit({ preparationId: prepared.preparationId, signature });
    } catch (cause) {
      onDispatched(prepared.swapId);
      throw cause;
    }
  });

  /** Any change to the terms retires the price the venue gave for the old ones. */
  function retireQuote() {
    setQuote(undefined);
    setSubmitted(undefined);
    setStale(false);
    requestQuote.clearError();
    requestSwap.clearError();
  }

  const now = useNow(quote !== undefined);
  const expired = quote !== undefined && Date.parse(quote.quoteExpiresAt) <= now;

  const amountError = amountProblem(amountIn, inputBalance, inSymbol || 'this token');
  const slippageError = slippageProblem(slippageBps, MAX_SLIPPAGE_BPS);
  const busy = requestQuote.pending || requestSwap.pending;

  if (pool.loading && !pool.data) return <Loading label="Loading the pool" />;

  return (
    <Card>
      <CardHeader
        title="Request a swap"
        description={
          pool.data ? `${pool.data.name} · ${formatFeeBps(pool.data.settings.feeBps)}` : undefined
        }
      />
      <div className="card-pad stack">
        {pool.error && !pool.data ? (
          <ErrorState error={pool.error} onRetry={pool.reload} />
        ) : null}

        <div className="grid-2">
          <SelectField
            label="Pool"
            value={poolId}
            disabled={busy}
            onChange={(event) => {
              retireQuote();
              onPoolId(event.target.value);
            }}
          >
            {pools.map((candidate) => (
              <option key={candidate.poolId} value={candidate.poolId}>
                {candidate.name}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Direction"
            value={direction}
            disabled={busy}
            onChange={(event) => {
              retireQuote();
              setDirection(event.target.value as SwapDirection);
            }}
          >
            <option value="BaseToQuote">
              {directionLabel('BaseToQuote', baseSymbol, quoteSymbol)}
            </option>
            <option value="QuoteToBase">
              {directionLabel('QuoteToBase', baseSymbol, quoteSymbol)}
            </option>
          </SelectField>
        </div>

        <div className="grid-2">
          <TextField
            label={`Amount in${inSymbol ? ` (${inSymbol})` : ''}`}
            value={amountIn}
            inputMode="decimal"
            placeholder="0.01"
            disabled={busy}
            hint={
              inputBalance
                ? `${formatExact(inputBalance.available, inputBalance.decimals)} ${inputBalance.symbol} available`
                : undefined
            }
            error={touched ? amountError : undefined}
            onChange={(event) => {
              retireQuote();
              setAmountIn(event.target.value);
            }}
          />
          <TextField
            label="Maximum slippage (bps)"
            value={slippageBps}
            inputMode="numeric"
            disabled={busy}
            error={touched ? slippageError : undefined}
            onChange={(event) => {
              retireQuote();
              setSlippageBps(event.target.value);
            }}
          />
        </div>

        {requestQuote.error ? (
          <Callout tone="danger">{requestQuote.error.message}</Callout>
        ) : null}

        <div className="row">
          <Button
            loading={requestQuote.pending}
            disabled={busy || pools.length === 0}
            onClick={async () => {
              setTouched(true);
              if (amountError || slippageError) return;
              const result = await requestQuote.perform();
              if (result) {
                // A new quote is a new preparation, so the venue's refusal to
                // prepare the old one no longer applies.
                setStale(false);
                setSubmitted(undefined);
                setQuote(result);
              }
            }}
          >
            {quote ? 'Refresh quote' : 'Get a quote'}
          </Button>
        </div>

        {quote ? (
          <QuotedTerms
            quote={quote}
            inSymbol={inSymbol}
            outSymbol={outSymbol}
            expired={expired}
            now={now}
            blocked={stale || unresolved !== undefined}
            pending={requestSwap.pending}
            // A request that is already with the venue explains itself below;
            // repeating the transport failure beside a Request swap button
            // would read as an invitation to sign it a second time.
            error={unresolved || stale ? undefined : requestSwap.error}
            onRequest={async () => {
              const swap = await requestSwap.perform(quote);
              if (!swap) return;
              setQuote(undefined);
              setSubmitted(swap);
              onSubmitted(swap);
            }}
          />
        ) : null}

        {stale ? (
          <Callout tone="warning">This quote already has a request</Callout>
        ) : null}

        {unresolved ? (
          <Callout tone="warning" title="Sent, outcome unknown">
            <span className="mono">{unresolved}</span>
          </Callout>
        ) : null}

        {submitted ? (
          <Callout tone="info" title="Request sent">
            <span className="mono">{submitted.swapId}</span>
          </Callout>
        ) : null}
      </div>
    </Card>
  );
}

function QuotedTerms({
  quote,
  inSymbol,
  outSymbol,
  expired,
  now,
  blocked,
  pending,
  error,
  onRequest,
}: {
  quote: SwapQuoteRecord;
  inSymbol: string;
  outSymbol: string;
  expired: boolean;
  now: number;
  /** True while an earlier request from this quote is still unresolved. */
  blocked: boolean;
  pending: boolean;
  error: Error | undefined;
  onRequest: () => void;
}) {
  const quoteExpired = error !== undefined && venueErrorCode(error) === 'QUOTE_EXPIRED';

  return (
    <div className="stack-sm">
      <DataList
        items={[
          {
            label: 'You pay',
            value: (
              <span className="tabular">
                {formatExact(quote.amountIn)} {inSymbol}
              </span>
            ),
          },
          {
            label: 'Estimated output',
            value: (
              <span className="tabular">
                {formatExact(quote.expectedOut)} {outSymbol}
              </span>
            ),
          },
          {
            label: 'Minimum output',
            value: (
              <span className="tabular">
                {formatExact(quote.minOut)} {outSymbol} · {quote.slippageBps} bps
              </span>
            ),
          },
          {
            label: 'Fee',
            value: (
              // The venue reports the fee at a finer precision than an amount
              // carries, because it is informational and never transferred on
              // its own. It is shown as sent rather than rounded here.
              <span className="tabular">
                {formatDecimal(quote.feeAmount, { maxFractionDigits: 14 })} {inSymbol}
              </span>
            ),
          },
          {
            label: 'Settles by',
            value: formatDateTime(quote.settlementDeadline),
          },
          {
            label: 'Quote expires',
            value: (
              <span aria-live="polite">
                {expired ? 'Expired' : `in ${formatCountdown(quote.quoteExpiresAt, now)}`}
              </span>
            ),
          },
        ]}
      />

      {error ? (
        <Callout tone="danger" title={quoteExpired ? 'Quote expired' : undefined}>
          {walletMessage(error)}
        </Callout>
      ) : null}

      <div className="row">
        <Button loading={pending} disabled={expired || blocked} onClick={onRequest}>
          Request swap
        </Button>
      </div>
    </div>
  );
}
