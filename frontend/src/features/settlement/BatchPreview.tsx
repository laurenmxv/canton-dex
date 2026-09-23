import { Banner, CardContent, LoadingButton as Button } from '@openzeppelin/ui-components';
import { cn } from '@openzeppelin/ui-utils';
import { useEffect, useId, useState } from 'react';
import type {
  InstrumentId,
  Settlement,
  SettlementOutputCheck,
  SettlementPreview,
  SettlementPreviewStep,
  SettlementRequestRef,
} from '../../lib/api/types';
import {
  batchSizeLabel,
  formatAge,
  RETRY_OF,
  settlementStatusLabels,
  settlementStatusTones,
  shortContract,
} from '../../lib/labels';
import { StatusBadge } from '../../ui/Badge';
import { Card, CardHeader, DataList } from '../../ui/Card';
import { TextLink } from '../../ui/Link';
import { Mono } from '../../ui/Mono';
import { EmptyState, ErrorState, RefreshFailure, SkeletonRows } from '../../ui/States';
import { FillAmounts, type PoolLabels } from './FillAmounts';
import {
  formatHeadroom,
  isThin,
  NO_PROJECTED_MOVE,
  NOTHING_TO_SETTLE,
  OBSERVED,
  reserveText,
  runBlocker,
  stepStateLabels,
  stepStateOf,
  stepStateTones,
  trajectory,
  type StepState,
} from './preview';
import {
  amount,
  canChangeHold,
  familyInfo,
  isExpired,
  type FamilyInfo,
  type QueueRow,
} from './queueRows';
import { DeferButton, DetailsButton } from './RequestCells';
import { TrajectoryChart } from './TrajectoryChart';
import type { PreviewRead } from './usePreview';
import type { RunIntentState } from './useRunIntent';

/** One restrained edge per step state, so the list reads like the chart. */
const EDGE: Record<StepState, string> = {
  projected: 'border-l-primary',
  thin: 'border-l-[color:var(--warning)]',
  blocked: 'border-l-[color:var(--destructive)]',
  unchecked: 'border-l-border',
};

/** One step of the preview, with the queued request it names where the queue still has it. */
interface Joined {
  step: SettlementPreviewStep;
  number: number;
  row: QueueRow | undefined;
  state: StepState;
}

type Labels = PoolLabels & { lp: InstrumentId };

function sameInstrument(a: InstrumentId, b: InstrumentId): boolean {
  return a.admin === b.admin && a.id === b.id;
}

/**
 * The next batch of one queue, before it runs: the requests in order, where
 * each would leave the pool, and the one action that runs exactly this.
 *
 * Every figure is the venue's projection from one observation, so nothing here
 * is a settlement. A projection that holds now can still fail on the ledger.
 */
export function BatchPreview({
  family,
  retryOf,
  preview,
  rows,
  batchSize,
  labels,
  inFlight,
  run,
  busy,
  holding,
  holdsLocked,
  holdError,
  now,
  onRun,
  onDefer,
  onOpen,
  onExitRetry,
}: {
  family: FamilyInfo;
  retryOf: string | null;
  preview: PreviewRead;
  /** Every queued row of this family, which is where a step's own terms come from. */
  rows: QueueRow[] | undefined;
  batchSize: number | undefined;
  labels: Labels;
  inFlight: Settlement | null;
  run: RunIntentState;
  /** A hold or a policy change is waiting for its answer. */
  busy: boolean;
  holding: string | undefined;
  holdsLocked: boolean;
  holdError: Error | undefined;
  now: number;
  onRun: (preview: SettlementPreview) => void;
  onDefer: (request: SettlementRequestRef) => void;
  onOpen: (row: QueueRow, trigger: HTMLElement) => void;
  onExitRetry: () => void;
}) {
  const regionId = useId();
  const headingId = useId();
  const reasonId = useId();
  const [pinned, setPinned] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  // A retry is reviewed from the history below, so the review moves the
  // reader here rather than changing a panel they cannot see.
  useEffect(() => {
    if (retryOf) document.getElementById(regionId)?.focus();
  }, [retryOf, regionId]);

  const data = preview.data;
  const joined: Joined[] = (data?.steps ?? []).map((step, index) => ({
    step,
    number: index + 1,
    row: rows?.find((row) => row.requestId === step.request.requestId),
    state: stepStateOf(step),
  }));
  const ids = joined.map(({ step }) => step.request.requestId);
  const known = (id: string | null) => (id !== null && ids.includes(id) ? id : null);
  const pinnedId = known(pinned);
  const activeId = known(hovered) ?? pinnedId;
  const numberOf = (id: string | null) => (id === null ? null : ids.indexOf(id) + 1);
  const idOf = (step: number) => ids[step - 1] ?? null;
  const active = joined.find(({ step }) => step.request.requestId === activeId);

  const blocker = runBlocker({
    preview: data,
    loading: preview.loading,
    failed: preview.error !== undefined,
    // A step the queue no longer lists means the preview is behind the queue.
    stale: preview.stale || joined.some(({ row }) => row === undefined),
    inFlight: inFlight !== null,
    unresolved: run.intent !== undefined,
    busy: busy || run.pending,
    expired: joined.some(({ row }) => row !== undefined && isExpired(row, now)),
  });
  const pin = (id: string) => setPinned((current) => (current === id ? null : id));
  // A run in flight shows its own spinner, so it needs no reason beside it.
  const reason = run.pending ? null : blocker;

  return (
    <Card id={regionId} tabIndex={-1} role="region" aria-labelledby={headingId} className="outline-none">
      <CardHeader
        titleId={headingId}
        title={`${family.noun} · next batch`}
        description={
          <Freshness
            preview={data}
            refreshing={preview.loading || (preview.stale && preview.error === undefined)}
            retryOf={retryOf}
            batchSize={batchSize}
            now={now}
            onExitRetry={onExitRetry}
          />
        }
        actions={
          <>
            {reason ? (
              <span id={reasonId} className="text-muted-foreground text-xs">
                {reason}
              </span>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              loading={preview.loading && data !== undefined}
              onClick={preview.reload}
            >
              Refresh
            </Button>
            <Button
              size="sm"
              loading={run.pending}
              disabled={blocker !== null}
              aria-describedby={reason ? reasonId : undefined}
              onClick={() => data && onRun(data)}
            >
              Run batch
            </Button>
          </>
        }
      />

      <Notices
        run={run}
        inFlight={inFlight}
        holdError={holdError}
        preview={preview}
        now={now}
      />

      <CardContent className="p-5">
        {!data ? (
          preview.error ? (
            <ErrorState error={preview.error} onRetry={preview.reload} />
          ) : (
            <SkeletonRows rows={3} label="Loading the next batch" />
          )
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
            {joined.length === 0 ? (
              <EmptyState title={NOTHING_TO_SETTLE} />
            ) : (
              <ol aria-label={`${family.noun}: requests in the next batch`} className="flex min-w-0 flex-col gap-1.5">
                {joined.map((item) => (
                  <StepRow
                    key={item.step.request.requestId}
                    item={item}
                    active={item.step.request.requestId === activeId}
                    pinned={item.step.request.requestId === pinnedId}
                    lp={labels.lp}
                    holding={holding}
                    holdsLocked={holdsLocked}
                    busy={busy || run.pending}
                    now={now}
                    onHover={setHovered}
                    onPin={pin}
                    onDefer={onDefer}
                    onOpen={onOpen}
                  />
                ))}
              </ol>
            )}
            <div className="flex min-w-0 flex-col gap-4">
              <TrajectoryChart
                points={trajectory(data)}
                family={family.type}
                activeStep={numberOf(activeId)}
                pinnedStep={numberOf(pinnedId)}
                baseLabel={labels.baseLabel}
                quoteLabel={labels.quoteLabel}
                onHover={(step) => setHovered(step === null ? null : idOf(step))}
                onPin={(step) => {
                  const id = idOf(step);
                  if (id) pin(id);
                }}
              />
              <StepKey preview={data} active={active} labels={labels} />
            </div>
          </div>
        )}

        <p className="text-muted-foreground mt-4 flex flex-wrap items-center gap-2 text-xs">
          <span>Projected from the observed state. The ledger decides what settles.</span>
          {run.answered ? (
            <span className="inline-flex items-center gap-2">
              · Last run <Mono>{shortContract(run.answered.settlementId)}</Mono>
              <StatusBadge
                tone={settlementStatusTones[run.answered.status]}
                label={settlementStatusLabels[run.answered.status]}
              />
            </span>
          ) : null}
        </p>
      </CardContent>
    </Card>
  );
}

function Freshness({
  preview,
  refreshing,
  retryOf,
  batchSize,
  now,
  onExitRetry,
}: {
  preview: SettlementPreview | undefined;
  refreshing: boolean;
  retryOf: string | null;
  batchSize: number | undefined;
  now: number;
  onExitRetry: () => void;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5">
      {retryOf ? (
        <>
          <span>
            {RETRY_OF} <Mono>{shortContract(retryOf)}</Mono> ·
          </span>
          <TextLink onClick={onExitRetry}>Back to the queue</TextLink>
          <span>·</span>
        </>
      ) : null}
      {preview ? <span>Observed {formatAge(preview.pool.observedAt, now)} ago</span> : null}
      {batchSize !== undefined ? <span>· up to {batchSize} per batch</span> : null}
      {preview && refreshing ? <span>· refreshing</span> : null}
    </span>
  );
}

function Notices({
  run,
  inFlight,
  holdError,
  preview,
  now,
}: {
  run: RunIntentState;
  inFlight: Settlement | null;
  holdError: Error | undefined;
  preview: PreviewRead;
  now: number;
}) {
  const unanswered = run.intent !== undefined && !run.pending ? run.intent : undefined;
  const refusal = run.intent === undefined ? run.error : undefined;
  const failedRefresh = preview.data !== undefined ? preview.error : undefined;
  if (!unanswered && !refusal && !holdError && !inFlight && !failedRefresh) return null;

  return (
    <CardContent className="flex flex-col gap-2 px-5 pt-4 pb-0">
      {unanswered ? (
        <Banner variant="warning" title="Batch status unknown" size="compact" dismissible={false}>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span>
              {run.error ? `${run.error.message} ` : ''}
              {run.unseen ? 'No batch under this key yet. ' : ''}
              <Mono>{unanswered.idempotencyKey}</Mono> · {familyInfo(unanswered.selection.type).noun},{' '}
              {unanswered.selection.requests.length} requested
            </span>
            <Button size="sm" variant="secondary" onClick={run.retry}>
              Retry this run
            </Button>
          </span>
        </Banner>
      ) : null}
      {refusal ? (
        <Banner variant="error" size="compact" dismissible={false}>
          {refusal.message}
        </Banner>
      ) : null}
      {holdError ? (
        <Banner variant="error" size="compact" dismissible={false}>
          {holdError.message}
        </Banner>
      ) : null}
      {inFlight ? (
        <p className="flex flex-wrap items-center gap-2 text-xs">
          <StatusBadge
            tone={settlementStatusTones[inFlight.status]}
            dot
            label={settlementStatusLabels[inFlight.status]}
          />
          <span>
            Batch in flight <Mono>{shortContract(inFlight.settlementId)}</Mono> · {batchSizeLabel(inFlight)} ·
            started {formatAge(inFlight.createdAt, now)} ago
          </span>
        </p>
      ) : null}
      {failedRefresh ? <RefreshFailure error={failedRefresh} onRetry={preview.reload} /> : null}
    </CardContent>
  );
}

function StepRow({
  item,
  active,
  pinned,
  lp,
  holding,
  holdsLocked,
  busy,
  now,
  onHover,
  onPin,
  onDefer,
  onOpen,
}: {
  item: Joined;
  active: boolean;
  pinned: boolean;
  lp: InstrumentId;
  holding: string | undefined;
  holdsLocked: boolean;
  busy: boolean;
  now: number;
  onHover: (id: string | null) => void;
  onPin: (id: string) => void;
  onDefer: (request: SettlementRequestRef) => void;
  onOpen: (row: QueueRow, trigger: HTMLElement) => void;
}) {
  const { step, number, row, state } = item;
  const id = step.request.requestId;
  const short = shortContract(id);
  const checked = step.status !== 'NOT_EVALUATED' && step.outputs.length > 0;

  return (
    <li
      data-active={active || undefined}
      onMouseEnter={() => onHover(id)}
      onMouseLeave={() => onHover(null)}
      className={cn(
        'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md border border-l-4 transition-colors',
        EDGE[state],
        active && 'bg-surface',
        pinned && 'bg-primary-soft',
      )}
    >
      <Button
        type="button"
        variant="ghost"
        aria-pressed={pinned}
        onClick={() => onPin(id)}
        onFocus={() => onHover(id)}
        onBlur={() => onHover(null)}
        className="h-auto min-w-0 flex-col items-stretch justify-start gap-1 rounded-md px-3 py-2 text-left font-normal whitespace-normal hover:bg-transparent"
      >
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground w-5 text-xs font-semibold tabular-nums">{number}</span>
          <span className="font-mono text-xs">{short}</span>
          <StatusBadge tone={stepStateTones[state]} label={stepStateLabels[state]} />
        </span>
        <span className="flex flex-col gap-0.5 pl-7 text-xs tabular-nums">
          {checked ? (
            <span className="flex flex-wrap items-baseline gap-x-2">
              {row ? <span className="text-muted-foreground">{row.offered} →</span> : null}
              <span className="flex flex-col">
                {step.outputs.map((check) => (
                  <Output key={`${check.instrument.admin}:${check.instrument.id}`} check={check} state={state} lp={lp} />
                ))}
              </span>
            </span>
          ) : row ? (
            <span className="text-muted-foreground">
              {row.offered} · minimum {row.minimum}
            </span>
          ) : null}
          {step.error ? <span className="text-destructive">{step.error}</span> : null}
        </span>
      </Button>
      {row ? (
        <span className="flex items-center gap-1 pr-2">
          {canChangeHold(row, now) ? (
            <DeferButton row={row} holding={holding} disabled={holdsLocked || busy} onDefer={onDefer} />
          ) : null}
          <DetailsButton row={row} onOpen={onOpen} />
        </span>
      ) : null}
    </li>
  );
}

/** One projected output: what it would pay, the minimum it was signed for, and the room between. */
function Output({ check, state, lp }: { check: SettlementOutputCheck; state: StepState; lp: InstrumentId }) {
  const unit = sameInstrument(check.instrument, lp) ? 'LP' : check.instrument;
  return (
    <span className="flex flex-wrap gap-x-2">
      <span className="text-foreground font-medium">{amount(check.amount, unit)}</span>
      <span className="text-muted-foreground">min {amount(check.minimum, unit)}</span>
      <span
        className={cn(
          state === 'blocked'
            ? 'text-destructive font-semibold'
            : isThin(check)
              ? 'font-semibold text-[color:var(--warning)]'
              : 'text-muted-foreground',
        )}
      >
        {formatHeadroom(check.headroomBps)}
      </span>
    </span>
  );
}

/**
 * What the step in focus would do to the pool, or what the batch would when
 * none is. A batch with a blocked step cannot run, so the key then shows only
 * the projected prefix before the blocker. Every figure is the venue's own;
 * nothing here is derived.
 */
function StepKey({
  preview,
  active,
  labels,
}: {
  preview: SettlementPreview;
  active: Joined | undefined;
  labels: Labels;
}) {
  const reserves = (pair: Parameters<typeof reserveText>[0]) =>
    reserveText(pair, labels.baseLabel, labels.quoteLabel);

  if (!active) {
    const end = preview.steps.filter((step) => step.status === 'VALID' && step.after).at(-1)?.after;
    const halted = preview.steps.some((step) => step.status === 'BLOCKED');
    const title = halted ? 'Projected prefix' : 'Whole batch';
    return (
      <section aria-label={title} className="flex flex-col gap-2">
        <h3 className="text-muted-foreground text-[0.6875rem] font-semibold tracking-[0.05em] uppercase">
          {title}
        </h3>
        <DataList
          items={[
            { label: OBSERVED, value: <span className="tabular-nums">{reserves(preview.pool.reserves)}</span> },
            {
              label: halted ? 'Before blocker' : 'After the batch',
              value: end ? <span className="tabular-nums">{reserves(end)}</span> : NO_PROJECTED_MOVE,
            },
          ]}
        />
      </section>
    );
  }

  const { step, number, state } = active;
  return (
    <section aria-label={`Step ${number}`} className="flex flex-col gap-2">
      <h3 className="text-muted-foreground text-[0.6875rem] font-semibold tracking-[0.05em] uppercase">
        Step {number} · {stepStateLabels[state]}
      </h3>
      {/* The venue checks nothing after a blocker, so this step has no state to show. */}
      {step.status === 'NOT_EVALUATED' ? null : (
        <DataList
          items={[
            { label: 'Before', value: <span className="tabular-nums">{reserves(step.before)}</span> },
            {
              label: 'After',
              value: step.after ? <span className="tabular-nums">{reserves(step.after)}</span> : 'Unchanged',
            },
            ...(step.fill
              ? [
                  {
                    label: 'Projected fill',
                    value: (
                      <FillAmounts fill={step.fill} baseLabel={labels.baseLabel} quoteLabel={labels.quoteLabel} />
                    ),
                  },
                ]
              : []),
            ...(step.error ? [{ label: step.errorCode ?? 'Why', value: step.error }] : []),
          ]}
        />
      )}
    </section>
  );
}
