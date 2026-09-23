import { Banner, CardContent, LoadingButton as Button } from '@openzeppelin/ui-components';
import { useState } from 'react';
import { useDexClient } from '../../app/runtime';
import { useAction, useLive, type AsyncResult } from '../../app/useAsync';
import { useNow } from '../../app/useNow';
import {
  MAX_SLIPPAGE_BPS,
  venueErrorCode,
  type DepositQuote,
  type DepositRequest,
  type PoolDetail,
  type PoolSummary,
  type TokenBalances,
} from '../../lib/api/types';
import { formatExact, isZeroAmount } from '../../lib/decimal';
import { formatDateTime, formatFeeBps } from '../../lib/labels';
import { Card, CardHeader, DataList } from '../../ui/Card';
import { SelectControl, TextControl } from '../../ui/Field';
import { ErrorState, Loading } from '../../ui/States';
import { lacksPoolAccess } from '../onboarding/progress';
import { amountProblem, balanceOf, instrumentLabel, slippageProblem } from '../swap/terms';
import type { WalletSigner } from '../wallet/signing';
import { quoteExpiry, refusedBeforeDispatch, TicketNotices } from './TicketNotices';

/** One deposit, from the venue's quote to a signed request. Every figure is the venue's. */
export function DepositTicket({
  pools,
  pool,
  poolId,
  onPoolId,
  balances,
  signer,
  unresolvedRequestId,
  onDispatched,
  onSubmitted,
}: {
  /** Only the pools the trader's current access opens. */
  pools: readonly PoolSummary[];
  pool: AsyncResult<PoolDetail>;
  poolId: string;
  onPoolId: (poolId: string) => void;
  balances: AsyncResult<TokenBalances>;
  signer: WalletSigner;
  unresolvedRequestId: string | undefined;
  onDispatched: (requestId: string | undefined) => void;
  onSubmitted: (request: DepositRequest) => void;
}) {
  const client = useDexClient();
  const live = useLive();
  const [maxBase, setMaxBase] = useState('');
  const [maxQuote, setMaxQuote] = useState('');
  const [slippageBps, setSlippageBps] = useState('50');
  const [touched, setTouched] = useState(false);
  const [quote, setQuote] = useState<DepositQuote>();
  const [submitted, setSubmitted] = useState<DepositRequest>();
  const [stale, setStale] = useState(false);

  const held = balances.data?.balances ?? [];
  const settings = pool.data?.settings;
  const baseSymbol = settings ? instrumentLabel(held, settings.baseInstrumentId) : '';
  const quoteSymbol = settings ? instrumentLabel(held, settings.quoteInstrumentId) : '';
  const baseBalance = settings ? balanceOf(held, settings.baseInstrumentId) : undefined;
  const quoteBalance = settings ? balanceOf(held, settings.quoteInstrumentId) : undefined;

  const requestQuote = useAction(() =>
    client.lp.quoteDeposit({
      poolId,
      maxBaseAmount: maxBase.trim(),
      maxQuoteAmount: maxQuote.trim(),
      slippageBps: Number(slippageBps.trim()),
    }),
  );

  // Once the signature has left, an ambiguous failure is handed up for recovery
  // rather than offered for signing again.
  const requestDeposit = useAction(async (approved: DepositQuote) => {
    let prepared;
    try {
      prepared = await client.lp.prepareDeposit({
        quoteId: approved.quoteId,
        minLpOut: approved.minLpOut,
        minRatio: approved.minRatio,
        maxRatio: approved.maxRatio,
        settlementDeadline: approved.settlementDeadline,
      });
    } catch (cause) {
      // The quote's earlier request may already be on the ledger; read it back.
      if (venueErrorCode(cause) === 'PREPARATION_EXPIRED') {
        setStale(true);
        onDispatched(undefined);
      }
      throw cause;
    }
    if (!live()) return;
    const { terms } = prepared;
    const signature = await signer.sign(prepared, {
      operation: 'Add liquidity',
      tokenSymbol: `${baseSymbol} + ${quoteSymbol}`,
      amount: `Up to ${terms.maxBaseAmount} ${baseSymbol} + ${terms.maxQuoteAmount} ${quoteSymbol} for at least ${terms.minLpOut} LP`,
      recipient: terms.poolName,
      sender: terms.trader,
    });
    if (!live()) return;
    try {
      return await client.lp.submitDeposit({ preparationId: prepared.preparationId, signature });
    } catch (cause) {
      if (refusedBeforeDispatch(cause)) setQuote(undefined);
      else onDispatched(prepared.requestId);
      throw cause;
    }
  });

  function retireQuote() {
    setQuote(undefined);
    setSubmitted(undefined);
    setStale(false);
    requestQuote.clearError();
    requestDeposit.clearError();
  }

  const now = useNow(quote !== undefined);
  const expiry = quote ? quoteExpiry(quote.quoteExpiresAt, now) : undefined;

  const baseError = amountProblem(maxBase, baseBalance, baseSymbol || 'this token');
  const quoteError = amountProblem(maxQuote, quoteBalance, quoteSymbol || 'this token');
  const slippageError = slippageProblem(slippageBps, MAX_SLIPPAGE_BPS);
  const busy = requestQuote.pending || requestDeposit.pending;

  if (pool.loading && !pool.data) return <Loading label="Loading the pool" />;

  return (
    <Card>
      <CardHeader
        title="Add liquidity"
        description={
          pool.data
            ? isZeroAmount(pool.data.settings.lpTokenSupply)
              ? `Empty pool · initial ratio ${formatExact(pool.data.settings.initialRatio)} ${quoteSymbol} per ${baseSymbol}`
              : `Fee ${formatFeeBps(pool.data.settings.feeBps)}`
            : undefined
        }
        actions={
          <SelectControl
            label="Pool"
            hideLabel
            controlClassName="h-8 text-xs"
            value={poolId}
            disabled={busy}
            onValueChange={(next) => {
              retireQuote();
              onPoolId(next);
            }}
            options={pools.map((candidate) => ({ value: candidate.poolId, label: candidate.name }))}
          />
        }
      />
      <CardContent className="p-5 flex flex-col gap-4">
        {pool.error && !pool.data ? <ErrorState error={pool.error} onRetry={pool.reload} /> : null}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <TextControl
            label={`Maximum ${baseSymbol || 'base'}`}
            value={maxBase}
            inputMode="decimal"
            placeholder="0.00"
            disabled={busy}
            hint={baseBalance ? `${formatExact(baseBalance.available, baseBalance.decimals)} ${baseBalance.symbol} available` : undefined}
            error={touched ? baseError : undefined}
            onChange={(event) => {
              retireQuote();
              setMaxBase(event.target.value);
            }}
          />
          <TextControl
            label={`Maximum ${quoteSymbol || 'quote'}`}
            value={maxQuote}
            inputMode="decimal"
            placeholder="0.00"
            disabled={busy}
            hint={quoteBalance ? `${formatExact(quoteBalance.available, quoteBalance.decimals)} ${quoteBalance.symbol} available` : undefined}
            error={touched ? quoteError : undefined}
            onChange={(event) => {
              retireQuote();
              setMaxQuote(event.target.value);
            }}
          />
        </div>

        <TextControl
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

        {requestQuote.error ? (
          <Banner variant="error" size="compact" dismissible={false}>
            {requestQuote.error.message}
          </Banner>
        ) : null}

        <Button
          className="w-full"
          loading={requestQuote.pending}
          disabled={busy || pools.length === 0}
          variant={quote ? 'secondary' : 'default'}
          onClick={async () => {
            setTouched(true);
            if (baseError || quoteError || slippageError) return;
            const result = await requestQuote.perform();
            if (result) {
              requestDeposit.clearError();
              setStale(false);
              setSubmitted(undefined);
              setQuote(result);
            }
          }}
        >
          {quote ? 'Refresh quote' : 'Get a quote'}
        </Button>

        {quote && expiry ? (
          <div className="flex flex-col gap-2">
            <div className="bg-surface rounded-md border px-4 py-3.5">
              <DataList
                variant="summary"
                items={[
                  {
                    label: 'Pricing',
                    value:
                      quote.mode === 'INITIAL' ? 'Initial ratio' : 'Proportional to reserves',
                  },
                  {
                    label: 'Expected deposit',
                    value: `${formatExact(quote.expectedBaseAmount)} ${baseSymbol} + ${formatExact(quote.expectedQuoteAmount)} ${quoteSymbol}`,
                  },
                  {
                    label: 'Expected refund',
                    value: `${formatExact(quote.expectedBaseRefund)} ${baseSymbol} + ${formatExact(quote.expectedQuoteRefund)} ${quoteSymbol}`,
                  },
                  { label: 'Expected LP', value: `${formatExact(quote.expectedLpOut)} LP` },
                  {
                    label: 'Minimum LP',
                    value: `${formatExact(quote.minLpOut)} LP · ${quote.slippageBps} bps`,
                  },
                  ...(quote.initialMinimumLp === null
                    ? []
                    : [
                        {
                          label: 'Locked in the pool for good',
                          value: `${formatExact(quote.initialMinimumLp)} LP`,
                        },
                      ]),
                  { label: 'Settles by', value: formatDateTime(quote.settlementDeadline) },
                  expiry.item,
                ]}
              />
            </div>

            <Button
              className="w-full"
              loading={requestDeposit.pending}
              disabled={
                expiry.expired ||
                stale ||
                unresolvedRequestId !== undefined ||
                (lacksPoolAccess(requestQuote.error) || lacksPoolAccess(requestDeposit.error))
              }
              onClick={async () => {
                const request = await requestDeposit.perform(quote);
                if (!request) return;
                setQuote(undefined);
                setSubmitted(request);
                onSubmitted(request);
              }}
            >
              Request deposit
            </Button>
          </div>
        ) : null}

        <TicketNotices
          error={requestDeposit.error}
          stale={stale}
          unresolved={unresolvedRequestId}
          submitted={submitted?.requestId}
        />
      </CardContent>
    </Card>
  );
}
