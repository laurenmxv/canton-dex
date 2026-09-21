import {
  Banner,
  CardContent,
  DataTable,
  LoadingButton as Button,
} from '@openzeppelin/ui-components';
import { NUMERIC } from '../../ui/table';
import { useId, useRef, useState } from 'react';
import { requireDemoApi } from '../../app/runtime';
import { useAction, useAsync, type ActionResult } from '../../app/useAsync';
import { useNow } from '../../app/useNow';
import type { Pool, SwapDirection, SwapPreparation, SwapQuote, SwapRequest } from '../../lib/api/types';
import { errorCode, MAX_SLIPPAGE_BPS, parseAmount } from '../../lib/api/types';
import { isLedgerDecimal, isZero, parseDecimal } from '../../lib/decimal';
import {
  directionLabel,
  formatAmount,
  formatCountdown,
  formatDateTime,
  shortDigest,
  symbolOf,
} from '../../lib/labels';
import { Mono } from '../../ui/Mono';
import { StatusBadge } from '../../ui/Badge';
import { Card, CardHeader, DataList } from '../../ui/Card';
import { SelectControl, TextControl } from '../../ui/Field';
import { AsyncSection, EmptyState, ErrorState, Loading } from '../../ui/States';
import { Steps, type StepItem } from '../../ui/Steps';
import { TokenLogo } from '../../ui/TokenLogo';
import { Note } from '../../ui/Note';
import { PageHeader } from '../../ui/PageHeader';

type Stage = 'compose' | 'review' | 'approve' | 'submitted';

/**
 * Lets a stage discard a reply that arrived after the trader started over.
 * Call it before the request; the closure it returns says whether the attempt
 * still stands.
 */
interface AttemptGuard {
  beginAttempt: () => () => boolean;
}

export function SwapRequestFlow({
  onGoToOnboarding,
  initialPoolId,
}: {
  onGoToOnboarding: () => void;
  /** The pool the trader arrived for, from the dashboard. */
  initialPoolId?: string;
}) {
  const openRequestsTitle = useId();
  const demo = requireDemoApi();
  const pools = useAsync(() => demo.swaps.eligiblePools(), [demo]);
  const requests = useAsync(() => demo.swaps.listRequests(), [demo]);
  const instruments = useAsync(() => demo.pools.listInstruments(), [demo]);

  if (pools.loading || instruments.loading) return <Loading label="Loading eligible pools" />;
  if (pools.error) return <ErrorState error={pools.error} onRetry={pools.reload} />;

  const symbol = (instrumentId: string) => symbolOf(instruments.data ?? [], instrumentId);

  return (
    <div className="flex flex-col gap-6 fade-in max-w-3xl">
      <PageHeader
        title="Request a swap"
        description="Price the trade, approve it, and wait for the pool to settle it."
      />

      {instruments.error ? (
        <Banner variant="warning" title="Instrument names unavailable" size="compact" dismissible={false}>
          {instruments.error.message}
        </Banner>
      ) : null}

      {pools.data && pools.data.length > 0 ? (
        <SwapComposer
          pools={pools.data}
          symbol={symbol}
          initialPoolId={initialPoolId}
          onSubmitted={requests.reload}
        />
      ) : (
        <Card>
          <EmptyState
            title="No pools available to you"
            action={
              <Button variant="secondary" size="sm" onClick={onGoToOnboarding}>
                Go to onboarding
              </Button>
            }
          />
        </Card>
      )}

      <Card>
        <CardHeader title="Your swap requests" titleId={openRequestsTitle} />
        <AsyncSection
          result={requests}
          label="Loading your requests"
          rows={2}
          empty={<EmptyState title="No requests yet" />}
        >
          {(list) => (
            <DataTable
              aria-labelledby={openRequestsTitle}
              columns={[
                {
                  id: 'request',
                  header: 'Request',
                  cellClassName: 'font-mono text-xs',
                  cell: (request) => request.requestId,
                },
                { id: 'pool', header: 'Pool', cell: (request) => request.poolName },
                {
                  ...NUMERIC,
                  id: 'amount-in',
                  header: 'Amount in',
                  cell: (request) => formatAmount(request.amountIn),
                },
                {
                  ...NUMERIC,
                  id: 'min-out',
                  header: 'Minimum out',
                  cell: (request) => formatAmount(request.minOut),
                },
                {
                  id: 'status',
                  header: 'Status',
                  cell: () => <StatusBadge tone="progress" dot label="Awaiting settlement" />,
                },
              ]}
              rows={list}
              getRowKey={(request) => request.requestId}
              className="border-0"
            />
          )}
        </AsyncSection>
      </Card>
    </div>
  );
}

function SwapComposer({
  pools,
  symbol,
  initialPoolId,
  onSubmitted,
}: {
  pools: Pool[];
  symbol: (instrumentId: string) => string;
  initialPoolId: string | undefined;
  onSubmitted: () => void;
}) {
  const demo = requireDemoApi();
  const [stage, setStage] = useState<Stage>('compose');
  // A pool this trader cannot reach falls through to the first one they can,
  // the same way an unknown one does.
  const [poolId, setPoolId] = useState(initialPoolId ?? pools[0]?.poolId ?? '');
  const [direction, setDirection] = useState<SwapDirection>('BaseToQuote');
  const [quote, setQuote] = useState<SwapQuote>();
  const [preparation, setPreparation] = useState<SwapPreparation>();
  const [request, setRequest] = useState<SwapRequest>();

  const now = useNow(stage === 'review' || stage === 'approve');
  const expired = quote !== undefined && Date.parse(quote.quoteExpiresAt) <= now;

  // A refreshed pool list must never leave the selection pointing at nothing.
  const selected = pools.find((candidate) => candidate.poolId === poolId) ?? pools[0];
  /**
   * Once a quote exists it, and not the form, describes the operation. The
   * form can still change underneath, and the reader must never be shown
   * terms the venue did not quote.
   */
  const quotedPool = quote
    ? pools.find((candidate) => candidate.poolId === quote.poolId)
    : selected;
  const shownDirection = quote?.direction ?? direction;
  const base = quotedPool ? symbol(quotedPool.baseInstrumentId) : '';
  const quoteSymbol = quotedPool ? symbol(quotedPool.quoteInstrumentId) : '';
  const inSymbol = shownDirection === 'BaseToQuote' ? base : quoteSymbol;
  const outSymbol = shownDirection === 'BaseToQuote' ? quoteSymbol : base;

  const prepare = useAction((quoteId: string) => demo.swaps.prepare(quoteId));
  const submit = useAction((preparationId: string) => demo.swaps.submit(preparationId));

  /**
   * Bumped whenever the trader starts over, so a quote or a preparation from
   * an abandoned attempt cannot advance the flow. Deliberately not applied to
   * submission: once the venue has registered a request, dropping the reply
   * would hide it.
   */
  const attempt = useRef(0);
  const beginAttempt = () => {
    const mine = attempt.current;
    return () => attempt.current === mine;
  };

  function restart() {
    attempt.current += 1;
    setStage('compose');
    setQuote(undefined);
    setPreparation(undefined);
    setRequest(undefined);
    // F1: a callout from the abandoned attempt must not greet the next one.
    prepare.clearError();
    submit.clearError();
  }

  const steps: StepItem[] = [
    {
      title: 'Choose pool and amount',
      state: stage === 'compose' ? 'current' : 'done',
      body:
        stage === 'compose' ? (
          <ComposeStage
            pools={pools}
            poolId={selected?.poolId ?? ''}
            onPoolId={setPoolId}
            direction={direction}
            onDirection={setDirection}
            base={selected ? symbol(selected.baseInstrumentId) : ''}
            quote={selected ? symbol(selected.quoteInstrumentId) : ''}
            beginAttempt={beginAttempt}
            onQuoted={(result) => {
              setQuote(result);
              setStage('review');
            }}
          />
        ) : quote ? (
          <DataList
            items={[
              { label: 'Pool', value: quotedPool?.name ?? quote.poolId },
              {
                label: 'Direction',
                value: directionLabel(quote.direction, base, quoteSymbol),
              },
              {
                label: 'Amount in',
                value: (
                  <span className="tabular-nums">
                    {formatAmount(quote.amountIn)} {inSymbol}
                  </span>
                ),
              },
            ]}
          />
        ) : null,
    },
    {
      title: 'Review the quote',
      state: stage === 'review' ? 'current' : quote && stage !== 'compose' ? 'done' : 'todo',
      body:
        quote && stage === 'review' ? (
          <QuoteStage
            quote={quote}
            inSymbol={inSymbol}
            outSymbol={outSymbol}
            feeBps={quotedPool?.feeBps}
            now={now}
            expired={expired}
            prepare={prepare}
            beginAttempt={beginAttempt}
            onPrepared={(result) => {
              setPreparation(result);
              setStage('approve');
            }}
            onRestart={restart}
          />
        ) : null,
    },
    {
      title: 'Approve in wallet',
      state: stage === 'approve' ? 'current' : stage === 'submitted' ? 'done' : 'todo',
      body:
        preparation && stage === 'approve' ? (
          <ApproveStage
            preparation={preparation}
            submit={submit}
            onSubmitted={(result) => {
              setRequest(result);
              setStage('submitted');
              onSubmitted();
            }}
            onCancel={restart}
          />
        ) : null,
    },
    {
      title: 'Awaiting settlement',
      state: stage === 'submitted' ? 'done' : 'todo',
      body: request ? <SubmittedStage request={request} onRestart={restart} /> : null,
    },
  ];

  return (
    <Card>
      <CardHeader
        title="New swap request"
        description={
          quotedPool ? `${quotedPool.name} · ${quotedPool.feeBps} bps fee` : undefined
        }
      />
      <CardContent className="p-5">
        <Steps steps={steps} />
      </CardContent>
    </Card>
  );
}

function ComposeStage({
  pools,
  poolId,
  onPoolId,
  direction,
  onDirection,
  base,
  quote,
  beginAttempt,
  onQuoted,
}: AttemptGuard & {
  pools: Pool[];
  poolId: string;
  onPoolId: (poolId: string) => void;
  direction: SwapDirection;
  onDirection: (direction: SwapDirection) => void;
  base: string;
  quote: string;
  onQuoted: (quote: SwapQuote) => void;
}) {
  const demo = requireDemoApi();
  const [amountIn, setAmountIn] = useState('');
  const [slippageBps, setSlippageBps] = useState('50');
  const [touched, setTouched] = useState(false);

  /*
   * The amount travels as the text the trader typed. Reading it into a number
   * and writing it back rewrites their figure: a ledger `Decimal` carries 28
   * integer and 10 fractional digits, and a double holds neither end. The same
   * check also keeps out the exponent and hex forms `Number` accepts and the
   * ledger's grammar does not.
   */
  const amountText = amountIn.trim();
  const amount = isLedgerDecimal(amountText) ? parseDecimal(amountText) : null;
  const slippage = parseAmount(slippageBps);
  const amountError = amount && !isZero(amount) ? undefined : 'Enter an amount above zero';
  const slippageError =
    slippage !== undefined && slippage >= 0 && slippage <= MAX_SLIPPAGE_BPS
      ? undefined
      : `Enter a slippage between 0 and ${MAX_SLIPPAGE_BPS} bps`;

  const requestQuote = useAction(() =>
    demo.swaps.requestQuote({
      poolId,
      direction,
      amountIn: amountText,
      slippageBps: slippage ?? 0,
    }),
  );
  const inSymbol = direction === 'BaseToQuote' ? base : quote;
  // While a quote is in flight the terms are fixed, so the reply always
  // matches what the trader last saw.
  const locked = requestQuote.pending;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <SelectControl
          label="Pool"
          value={poolId}
          disabled={locked}
          onValueChange={onPoolId}
          options={pools.map((candidate) => ({
            value: candidate.poolId,
            label: candidate.name,
          }))}
        />
        <SelectControl
          label="Direction"
          value={direction}
          disabled={locked}
          onValueChange={(next) => onDirection(next as SwapDirection)}
          options={[
            { value: 'BaseToQuote', label: directionLabel('BaseToQuote', base, quote) },
            { value: 'QuoteToBase', label: directionLabel('QuoteToBase', base, quote) },
          ]}
        />
      </div>

      {/* The amount is what the trader is deciding, so it is set as a figure
          and the pair it is paid in sits beside it. */}
      <div className="bg-surface focus-within:border-primary-border flex flex-col gap-2 rounded-lg border px-4 pt-3.5 pb-4 transition-colors">
        <div className="text-muted-foreground flex items-center justify-between gap-3 text-[0.75rem]">
          <span className="font-[550] tracking-[0.02em]">You pay</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1 [&_input]:h-9 [&_input]:border-0 [&_input]:bg-transparent [&_input]:p-0 [&_input]:text-[1.625rem] [&_input]:font-semibold [&_input]:tracking-[-0.02em] [&_input]:tabular-nums [&_input]:focus-visible:ring-0 [&_p]:text-[0.75rem]">
            <TextControl
              label={`Amount in${inSymbol ? ` (${inSymbol})` : ''}`}
              hideLabel
              value={amountIn}
              inputMode="decimal"
              // Set as a figure, a placeholder of a plausible amount reads as
              // one the trader entered.
              placeholder="0.00"
              disabled={locked}
              error={touched ? amountError : undefined}
              onChange={(event) => setAmountIn(event.target.value)}
            />
          </div>
          {inSymbol ? (
            <span className="bg-card shadow-card inline-flex flex-none items-center gap-[0.4375rem] rounded-full border py-[0.3125rem] pr-3 pl-[0.3125rem] text-sm font-semibold">
              <TokenLogo symbol={inSymbol} size="sm" />
              {inSymbol}
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex items-end gap-2">
        <TextControl
          label="Maximum slippage"
          value={slippageBps}
          inputMode="numeric"
          disabled={locked}
          error={touched ? slippageError : undefined}
          onChange={(event) => setSlippageBps(event.target.value)}
        />
      </div>

      {requestQuote.error ? <Banner variant="error" size="compact" dismissible={false}>{requestQuote.error.message}</Banner> : null}
      <Button
        className="w-full"
        loading={requestQuote.pending}
        onClick={async () => {
          setTouched(true);
          if (amountError || slippageError) return;
          const stillCurrent = beginAttempt();
          const result = await requestQuote.perform();
          if (result && stillCurrent()) onQuoted(result);
        }}
      >
        Request quote
      </Button>
    </div>
  );
}

function QuoteStage({
  quote,
  inSymbol,
  outSymbol,
  feeBps,
  now,
  expired,
  prepare,
  beginAttempt,
  onPrepared,
  onRestart,
}: AttemptGuard & {
  quote: SwapQuote;
  inSymbol: string;
  outSymbol: string;
  /** Absent when the quoted pool is no longer in the caller's list. */
  feeBps: number | undefined;
  now: number;
  expired: boolean;
  prepare: ActionResult<[string], SwapPreparation>;
  onPrepared: (preparation: SwapPreparation) => void;
  onRestart: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <DataList
        items={[
          {
            label: 'Expected output',
            value: (
              <span className="tabular-nums">
                {formatAmount(quote.expectedOut)} {outSymbol}
              </span>
            ),
          },
          {
            label: 'Fee',
            value: (
              <span className="tabular-nums">
                {formatAmount(quote.feeAmount)} {inSymbol}
                {feeBps === undefined ? '' : ` · ${feeBps} bps`}
              </span>
            ),
          },
          {
            label: 'Minimum output',
            value: (
              <span className="tabular-nums">
                {formatAmount(quote.minOut)} {outSymbol}
              </span>
            ),
          },
          {
            label: 'Quote expires',
            value: (
              <span aria-live="polite">
                {formatDateTime(quote.quoteExpiresAt)} ·{' '}
                {expired ? 'expired' : `in ${formatCountdown(quote.quoteExpiresAt, now)}`}
              </span>
            ),
          },
          { label: 'Settlement deadline', value: formatDateTime(quote.settlementDeadline) },
        ]}
      />
      {prepare.error ? (
        <Banner
          variant="error"
          title={errorCode(prepare.error) === 'EXPIRED' ? 'Quote expired' : undefined}
         size="compact" dismissible={false}>
          {prepare.error.message}
        </Banner>
      ) : null}
      <div className="flex items-center gap-3">
        <Button
          loading={prepare.pending}
          disabled={expired}
          onClick={async () => {
            const stillCurrent = beginAttempt();
            const result = await prepare.perform(quote.quoteId);
            // A preparation that lands after "Change amount" is abandoned.
            if (result && stillCurrent()) onPrepared(result);
          }}
        >
          Confirm these details
        </Button>
        <Button
          variant={expired ? 'default' : 'ghost'}
          disabled={prepare.pending}
          onClick={onRestart}
        >
          {expired ? 'Request a new quote' : 'Change amount'}
        </Button>
      </div>
    </div>
  );
}

function ApproveStage({
  preparation,
  submit,
  onSubmitted,
  onCancel,
}: {
  preparation: SwapPreparation;
  submit: ActionResult<[string], SwapRequest>;
  onSubmitted: (request: SwapRequest) => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Note tone="demo">Simulated wallet approval</Note>
      <DataList
        items={[
          { label: 'Preparation', value: <Mono>{preparation.preparationId}</Mono> },
          {
            label: 'Command digest',
            value: <Mono>{shortDigest(preparation.commandDigest)}</Mono>,
          },
        ]}
      />
      {submit.error ? <Banner variant="error" size="compact" dismissible={false}>{submit.error.message}</Banner> : null}
      <div className="flex items-center gap-3">
        <Button
          loading={submit.pending}
          onClick={async () => {
            const result = await submit.perform(preparation.preparationId);
            if (result) onSubmitted(result);
          }}
        >
          Approve and submit
        </Button>
        {/* Once the request is on its way, cancelling would be a lie. */}
        <Button variant="ghost" disabled={submit.pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function SubmittedStage({
  request,
  onRestart,
}: {
  request: SwapRequest;
  onRestart: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <DataList
        items={[
          { label: 'Request', value: <Mono>{request.requestId}</Mono> },
          {
            label: 'Status',
            value: (
              <StatusBadge tone="progress" dot label="Awaiting settlement" />
            ),
          },
          { label: 'Submitted', value: formatDateTime(request.submittedAt) },
          { label: 'Settles by', value: formatDateTime(request.settlementDeadline) },
        ]}
      />
      <div>
        <Button variant="secondary" onClick={onRestart}>
          Request another swap
        </Button>
      </div>
    </div>
  );
}
