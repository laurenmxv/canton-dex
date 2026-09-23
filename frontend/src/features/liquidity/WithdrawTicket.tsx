import { Banner, CardContent, LoadingButton as Button } from '@openzeppelin/ui-components';
import { useState } from 'react';
import { useDexClient } from '../../app/runtime';
import { useAction, useLive } from '../../app/useAsync';
import { useNow } from '../../app/useNow';
import {
  MAX_SLIPPAGE_BPS,
  venueErrorCode,
  type LpPosition,
  type TokenBalance,
  type WithdrawalQuote,
  type WithdrawalRequest,
} from '../../lib/api/types';
import { formatDateTime } from '../../lib/labels';
import { formatExact } from '../../lib/decimal';
import { Card, CardHeader, DataList } from '../../ui/Card';
import { TextControl } from '../../ui/Field';
import { lacksPoolAccess } from '../onboarding/progress';
import { amountProblem, instrumentLabel, slippageProblem } from '../swap/terms';
import type { WalletSigner } from '../wallet/signing';
import { lpBalance } from './terms';
import { quoteExpiry, refusedBeforeDispatch, TicketNotices } from './TicketNotices';

/** Redeeming LP from one position. It needs a confirmed wallet and current access to the pool. */
export function WithdrawTicket({
  position,
  balances,
  signer,
  unresolvedRequestId,
  onDispatched,
  onSubmitted,
  onClose,
}: {
  position: LpPosition;
  balances: readonly TokenBalance[];
  signer: WalletSigner;
  unresolvedRequestId: string | undefined;
  onDispatched: (requestId: string | undefined) => void;
  onSubmitted: (request: WithdrawalRequest) => void;
  onClose: () => void;
}) {
  const client = useDexClient();
  const live = useLive();
  const [lpAmount, setLpAmount] = useState('');
  const [slippageBps, setSlippageBps] = useState('50');
  const [touched, setTouched] = useState(false);
  const [quote, setQuote] = useState<WithdrawalQuote>();
  const [submitted, setSubmitted] = useState<WithdrawalRequest>();
  const [stale, setStale] = useState(false);

  const lp = lpBalance(position);
  const baseSymbol = instrumentLabel(balances, position.baseInstrument);
  const quoteSymbol = instrumentLabel(balances, position.quoteInstrument);

  const requestQuote = useAction(() =>
    client.lp.quoteWithdrawal({
      poolId: position.poolId,
      lpAmount: lpAmount.trim(),
      slippageBps: Number(slippageBps.trim()),
    }),
  );

  const requestWithdrawal = useAction(async (approved: WithdrawalQuote) => {
    let prepared;
    try {
      prepared = await client.lp.prepareWithdrawal({
        quoteId: approved.quoteId,
        minBaseOut: approved.minBaseOut,
        minQuoteOut: approved.minQuoteOut,
        settlementDeadline: approved.settlementDeadline,
      });
    } catch (cause) {
      if (venueErrorCode(cause) === 'PREPARATION_EXPIRED') {
        setStale(true);
        onDispatched(undefined);
      }
      throw cause;
    }
    if (!live()) return;
    const { terms } = prepared;
    const signature = await signer.sign(prepared, {
      operation: 'Remove liquidity',
      tokenSymbol: lp.symbol,
      amount: `${terms.lpAmount} ${lp.symbol} for at least ${terms.minBaseOut} ${baseSymbol} + ${terms.minQuoteOut} ${quoteSymbol}`,
      recipient: terms.poolName,
      sender: terms.trader,
    });
    if (!live()) return;
    try {
      return await client.lp.submitWithdrawal({ preparationId: prepared.preparationId, signature });
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
    requestWithdrawal.clearError();
  }

  const now = useNow(quote !== undefined);
  const expiry = quote ? quoteExpiry(quote.quoteExpiresAt, now) : undefined;
  const amountError = amountProblem(lpAmount, lp, lp.symbol);
  const slippageError = slippageProblem(slippageBps, MAX_SLIPPAGE_BPS);
  const busy = requestQuote.pending || requestWithdrawal.pending;

  return (
    <Card>
      <CardHeader
        title={`Remove liquidity · ${position.poolName}`}
        actions={
          <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
            Close
          </Button>
        }
      />
      <CardContent className="p-5 flex flex-col gap-4">
        <TextControl
          label="LP to redeem"
          value={lpAmount}
          inputMode="decimal"
          placeholder="0.00"
          disabled={busy}
          hint={`${formatExact(lp.available, lp.decimals)} ${lp.symbol} available`}
          error={touched ? amountError : undefined}
          onChange={(event) => {
            retireQuote();
            setLpAmount(event.target.value);
          }}
        />
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
          disabled={busy}
          variant={quote ? 'secondary' : 'default'}
          onClick={async () => {
            setTouched(true);
            if (amountError || slippageError) return;
            const result = await requestQuote.perform();
            if (result) {
              requestWithdrawal.clearError();
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
                    label: 'Expected output',
                    value: `${formatExact(quote.expectedBaseOut)} ${baseSymbol} + ${formatExact(quote.expectedQuoteOut)} ${quoteSymbol}`,
                  },
                  {
                    label: 'Minimum output',
                    value: `${formatExact(quote.minBaseOut)} ${baseSymbol} + ${formatExact(quote.minQuoteOut)} ${quoteSymbol} · ${quote.slippageBps} bps`,
                  },
                  { label: 'Settles by', value: formatDateTime(quote.settlementDeadline) },
                  expiry.item,
                ]}
              />
            </div>
            <Button
              className="w-full"
              loading={requestWithdrawal.pending}
              disabled={
                expiry.expired ||
                stale ||
                unresolvedRequestId !== undefined ||
                (lacksPoolAccess(requestQuote.error) || lacksPoolAccess(requestWithdrawal.error))
              }
              onClick={async () => {
                const request = await requestWithdrawal.perform(quote);
                if (!request) return;
                setQuote(undefined);
                setSubmitted(request);
                onSubmitted(request);
              }}
            >
              Request withdrawal
            </Button>
          </div>
        ) : null}

        <TicketNotices
          error={requestWithdrawal.error}
          stale={stale}
          unresolved={unresolvedRequestId}
          submitted={submitted?.requestId}
        />
      </CardContent>
    </Card>
  );
}
