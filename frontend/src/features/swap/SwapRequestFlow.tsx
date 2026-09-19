import { useEffect, useRef, useState } from 'react';
import { requireDemoApi } from '../../app/runtime';
import { useAction, useAsync, type ActionResult } from '../../app/useAsync';
import type { Pool, SwapDirection, SwapPreparation, SwapQuote, SwapRequest } from '../../lib/api/types';
import { errorCode, MAX_SLIPPAGE_BPS, parseAmount, toDecimal } from '../../lib/api/types';
import {
  directionLabel,
  formatAmount,
  formatCountdown,
  formatDateTime,
  shortDigest,
  symbolOf,
} from '../../lib/labels';
import { Badge, Callout } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card, CardHeader, DataList } from '../../ui/Card';
import { SelectField, TextField } from '../../ui/Field';
import { AsyncSection, EmptyState, ErrorState, Loading } from '../../ui/States';
import { Steps, type StepItem } from '../../ui/Steps';

type Stage = 'compose' | 'review' | 'approve' | 'submitted';

/**
 * Lets a stage discard a reply that arrived after the trader started over.
 * Call it before the request; the closure it returns says whether the attempt
 * still stands.
 */
interface AttemptGuard {
  beginAttempt: () => () => boolean;
}

/** Re-renders once a second, so a quote's remaining time never freezes. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function SwapRequestFlow({ onGoToOnboarding }: { onGoToOnboarding: () => void }) {
  const demo = requireDemoApi();
  const pools = useAsync(() => demo.swaps.eligiblePools(), [demo]);
  const requests = useAsync(() => demo.swaps.listRequests(), [demo]);
  const instruments = useAsync(() => demo.pools.listInstruments(), [demo]);

  if (pools.loading || instruments.loading) return <Loading label="Loading eligible pools" />;
  if (pools.error) return <ErrorState error={pools.error} onRetry={pools.reload} />;

  const symbol = (instrumentId: string) => symbolOf(instruments.data ?? [], instrumentId);

  return (
    <div className="stack-lg fade-in">
      <header className="page-head">
        <h1 className="page-title">Request a swap</h1>
        <p className="page-lede">
          Quote, confirm, approve, submit. The request is registered and waits for settlement. This
          demo never settles it and never credits an output balance.
        </p>
      </header>

      {instruments.error ? (
        <Callout tone="warning" title="Instrument names unavailable">
          {instruments.error.message} Amounts below show raw identifiers instead of symbols.
        </Callout>
      ) : null}

      {pools.data && pools.data.length > 0 ? (
        <SwapComposer pools={pools.data} symbol={symbol} onSubmitted={requests.reload} />
      ) : (
        <Card>
          <EmptyState
            title="No pools available to you"
            description="Complete onboarding and get approved for at least one pool first."
            action={
              <Button variant="secondary" size="sm" onClick={onGoToOnboarding}>
                Go to onboarding
              </Button>
            }
          />
        </Card>
      )}

      <Card>
        <CardHeader
          title="Your swap requests"
          description="Registered on the ledger and awaiting settlement."
        />
        <AsyncSection
          result={requests}
          label="Loading your requests"
          rows={2}
          empty={
            <EmptyState
              title="No requests yet"
              description="A submitted swap appears here while it waits for settlement."
            />
          }
        >
          {(list) => (
            <table className="table">
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Pool</th>
                  <th className="table-num">Amount in</th>
                  <th className="table-num">Minimum out</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {list.map((request) => (
                  <tr key={request.requestId}>
                    <td className="mono">{request.requestId}</td>
                    <td>{request.poolName}</td>
                    <td className="table-num">{formatAmount(request.amountIn)}</td>
                    <td className="table-num">{formatAmount(request.minOut)}</td>
                    <td>
                      <Badge tone="progress" dot>
                        Awaiting settlement
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </AsyncSection>
      </Card>
    </div>
  );
}

function SwapComposer({
  pools,
  symbol,
  onSubmitted,
}: {
  pools: Pool[];
  symbol: (instrumentId: string) => string;
  onSubmitted: () => void;
}) {
  const demo = requireDemoApi();
  const [stage, setStage] = useState<Stage>('compose');
  const [poolId, setPoolId] = useState(pools[0]?.poolId ?? '');
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
                  <span className="tabular">
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
      <div className="card-pad">
        <Steps steps={steps} />
      </div>
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

  const amount = parseAmount(amountIn);
  const slippage = parseAmount(slippageBps);
  const amountError = amount !== undefined && amount > 0 ? undefined : 'Enter an amount above zero';
  const slippageError =
    slippage !== undefined && slippage >= 0 && slippage <= MAX_SLIPPAGE_BPS
      ? undefined
      : `Enter a slippage between 0 and ${MAX_SLIPPAGE_BPS} bps`;

  const requestQuote = useAction(() =>
    demo.swaps.requestQuote({
      poolId,
      direction,
      amountIn: toDecimal(amount ?? 0),
      slippageBps: slippage ?? 0,
    }),
  );
  const inSymbol = direction === 'BaseToQuote' ? base : quote;
  // While a quote is in flight the terms are fixed, so the reply always
  // matches what the trader last saw.
  const locked = requestQuote.pending;

  return (
    <div className="stack">
      <div className="grid-2">
        <SelectField
          label="Pool"
          value={poolId}
          disabled={locked}
          onChange={(event) => onPoolId(event.target.value)}
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
          disabled={locked}
          onChange={(event) => onDirection(event.target.value as SwapDirection)}
        >
          <option value="BaseToQuote">{directionLabel('BaseToQuote', base, quote)}</option>
          <option value="QuoteToBase">{directionLabel('QuoteToBase', base, quote)}</option>
        </SelectField>
      </div>
      <div className="grid-2">
        <TextField
          label={`Amount in${inSymbol ? ` (${inSymbol})` : ''}`}
          value={amountIn}
          inputMode="decimal"
          placeholder="25000"
          disabled={locked}
          error={touched ? amountError : undefined}
          onChange={(event) => setAmountIn(event.target.value)}
        />
        <TextField
          label="Maximum slippage"
          value={slippageBps}
          inputMode="numeric"
          hint="Basis points. Sets the minimum output."
          disabled={locked}
          error={touched ? slippageError : undefined}
          onChange={(event) => setSlippageBps(event.target.value)}
        />
      </div>
      {requestQuote.error ? <Callout tone="danger">{requestQuote.error.message}</Callout> : null}
      <div>
        <Button
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
    <div className="stack">
      <DataList
        items={[
          {
            label: 'Expected output',
            value: (
              <span className="tabular">
                {formatAmount(quote.expectedOut)} {outSymbol}
              </span>
            ),
          },
          {
            label: 'Fee',
            value: (
              <span className="tabular">
                {formatAmount(quote.feeAmount)} {inSymbol}
                {feeBps === undefined ? '' : ` · ${feeBps} bps`}
              </span>
            ),
          },
          {
            label: 'Minimum output',
            value: (
              <span className="tabular">
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
        <Callout
          tone="danger"
          title={errorCode(prepare.error) === 'EXPIRED' ? 'Quote expired' : undefined}
        >
          {prepare.error.message}
        </Callout>
      ) : null}
      <div className="row">
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
          variant={expired ? 'primary' : 'ghost'}
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
    <div className="stack">
      <Callout tone="demo" title="Simulated wallet approval">
        No external wallet is contacted and no key signs anything. Pressing approve stands in for
        the signature a real trader would give.
      </Callout>
      <DataList
        items={[
          { label: 'Preparation', value: <span className="mono">{preparation.preparationId}</span> },
          {
            label: 'Command digest',
            value: <span className="mono">{shortDigest(preparation.commandDigest)}</span>,
          },
        ]}
      />
      {submit.error ? <Callout tone="danger">{submit.error.message}</Callout> : null}
      <div className="row">
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
    <div className="stack">
      <DataList
        items={[
          { label: 'Request', value: <span className="mono">{request.requestId}</span> },
          {
            label: 'Status',
            value: (
              <Badge tone="progress" dot>
                Awaiting settlement
              </Badge>
            ),
          },
          { label: 'Submitted', value: formatDateTime(request.submittedAt) },
          { label: 'Settles by', value: formatDateTime(request.settlementDeadline) },
        ]}
      />
      <Callout tone="info">
        The request is registered. Settlement is out of scope for this demo, so no output balance is
        credited.
      </Callout>
      <div>
        <Button variant="secondary" onClick={onRestart}>
          Request another swap
        </Button>
      </div>
    </div>
  );
}
