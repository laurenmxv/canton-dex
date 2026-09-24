import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useDexClient } from '../../app/runtime';
import { useAction, useAsync } from '../../app/useAsync';
import { useNow } from '../../app/useNow';
import type { PoolDetail, Settlement, SettlementPreview, SettlementRequestRef } from '../../lib/api/types';
import { RefreshFailure } from '../../ui/States';
import { BatchHistory } from './BatchHistory';
import { BatchPreview, RunNotices } from './BatchPreview';
import { DeferredList } from './DeferredList';
import { PoolState } from './PoolState';
import { runBlocker } from './preview';
import { QueueOverview } from './QueueOverview';
import {
  byArrival,
  FAMILIES,
  familyInfo,
  holdLabels,
  isWaiting,
  policyOf,
  queueToken,
  rowOf,
  selectsOnly,
  summarize,
  type Family,
  type FamilySummary,
  type QueueRow,
  type View,
} from './queueRows';
import { QueueSettings } from './QueueSettings';
import { QueueTable } from './QueueTable';
import { RequestDetail, requestEvidence } from './RequestDetail';
import { RunBatch } from './RunBatch';
import { RunRequest } from './RunRequest';
import { IN_FLIGHT_STATUSES, useBatchHistory } from './useBatchHistory';
import { usePreview } from './usePreview';
import { useQueuePolicy } from './useQueuePolicy';
import { useRunIntent } from './useRunIntent';

/**
 * This pool's work arrives from elsewhere: traders sign requests and the
 * venue's worker settles batches. An idle pool is exactly when something new
 * appears, so these reads never stop while an operator is watching. The
 * reading hook bounds them, pausing on a hidden tab and backing off on
 * failure.
 */
const WATCH = () => true;

/**
 * Everything one pool's settlement is made of. The parent keys it on the pool,
 * so one pool's answer, preview, filters and open request can never land
 * under another's name, and nothing chosen for one pool can run on another.
 */
export function PoolSettlement({ pool }: { pool: PoolDetail }) {
  const client = useDexClient();
  const poolId = pool.poolId;
  const [family, setFamily] = useState<Family>('swap');
  /** The rejected or cancelled attempt whose retry the workspace previews. */
  const [retryOf, setRetryOf] = useState<string | null>(null);
  const [view, setView] = useState<View>('all');
  const [search, setSearch] = useState('');
  /** The open request, as last read, so it survives leaving the active queue. */
  const [selected, setSelected] = useState<QueueRow>();
  /** The request whose hold is being changed. */
  const [holding, setHolding] = useState<string>();
  const trigger = useRef<HTMLElement | null>(null);
  const searchId = useId();
  const previewId = useId();

  const monitoring = useAsync(
    (signal) => client.admin.settlements.monitoring(poolId, { signal }),
    [client, poolId],
    { pollWhile: WATCH },
  );
  const queue = useAsync(
    // The route defaults to the ready requests alone; an operator needs the
    // blocked, deferred and in-flight ones too, or the queue reads as shorter
    // than it is.
    (signal) => client.admin.settlements.requests(poolId, 'active', { signal }),
    [client, poolId],
    { pollWhile: WATCH },
  );
  // The latest batches, which is where a request that just left the queue
  // finds its outcome. The history below pages through all of them.
  const batches = useAsync(
    (signal) => client.admin.settlements.list(poolId, { signal }),
    [client, poolId],
    { pollWhile: WATCH },
  );
  const history = useBatchHistory(poolId);

  const now = useNow(true);

  const rows = useMemo(() => {
    if (!queue.data) return undefined;
    const all = queue.data.map(rowOf);
    const grouped = {} as Record<Family, QueueRow[]>;
    for (const { type } of FAMILIES) {
      grouped[type] = all.filter((row) => row.family === type).sort(byArrival);
    }
    return grouped;
  }, [queue.data]);

  const summaries = useMemo(() => {
    if (!rows) return undefined;
    const result = {} as Record<Family, FamilySummary>;
    for (const { type } of FAMILIES) result[type] = summarize(rows[type]);
    return result;
  }, [rows]);

  const familyRows = rows?.[family];
  // The newest settings the venue confirmed for this queue. A save moves them
  // from its own answer, so the preview it outdated cannot run while monitoring
  // catches up. Another queue's save moves none of them.
  const settings = useQueuePolicy(poolId, family, monitoring.data?.policies, monitoring.reload);
  const preview = usePreview({
    poolId,
    family,
    retryOf,
    poolVersion: monitoring.data?.pool.version,
    policyVersion: settings.current.data?.version,
    queue: familyRows && queueToken(familyRows),
    now,
  });

  const run = useRunIntent(poolId, batches.data, (batch) => {
    if (batch) setRetryOf(null);
    reload();
  });
  const knownBatches = run.answered ? [run.answered, ...(batches.data ?? [])] : batches.data;
  const live = selected
    ? rows?.[selected.family].find((row) => row.requestId === selected.requestId)
    : undefined;
  useEffect(() => {
    if (live) setSelected(live);
  }, [live]);
  // The open request as the queue now reads it, while it waits there. One no
  // operator holds back is previewed alone, apart from the batch preview.
  const requestBatch = selected && requestEvidence(live ?? selected, knownBatches).batch;
  const pendingRequest = requestBatch && IN_FLIGHT_STATUSES.has(requestBatch.status) ? requestBatch : null;
  const waiting = live && isWaiting(live, now) && requestBatch?.status !== 'CONFIRMED' && !pendingRequest
    ? live
    : undefined;
  const single = waiting && !waiting.deferred ? waiting : undefined;
  const alone = usePreview({
    poolId,
    family: single?.family ?? family,
    retryOf: null,
    request: single && { type: single.family, requestId: single.requestId },
    enabled: single !== undefined,
    poolVersion: monitoring.data?.pool.version,
    policyVersion: single && policyOf(settings.policies, single.family)?.version,
    queue: single && queueToken([single]),
    now,
  });

  function reload() {
    monitoring.reload();
    queue.reload();
    batches.reload();
    history.page.reload();
    preview.reload();
    alone.reload();
  }

  const hold = useAction((request: SettlementRequestRef, deferred: boolean) =>
    client.admin.settlements.setDeferred(poolId, request, deferred),
  );
  const inFlight = monitoring.data?.activeSettlement ?? null;
  const busy = hold.pending || settings.saving || run.pending;
  // One batch at a time per pool: a run in flight or unanswered on any queue
  // holds every queue's run.
  const blocker = runBlocker({
    preview,
    rows: familyRows,
    now,
    inFlight: inFlight !== null,
    unresolved: run.intent !== undefined,
    busy,
  });
  const aloneBlocker = waiting?.deferred
    ? `${holdLabels.back} first`
    : runBlocker({
        preview: alone,
        rows: single && rows?.[single.family],
        now,
        inFlight: inFlight !== null,
        unresolved: run.intent !== undefined,
        busy,
      });

  async function changeHold(request: SettlementRequestRef, deferred: boolean) {
    setHolding(request.requestId);
    await hold.perform(request, deferred);
    setHolding(undefined);
    reload();
  }

  /** Runs the batch on screen, and only if it is still this pool's and this queue's. */
  function runPreviewed(shown: SettlementPreview) {
    if (shown.pool.poolId !== poolId || shown.selection.type !== family) return;
    run.run(shown.selection);
  }

  /** Runs the open request alone, and only if the preview on screen is of that request alone. */
  function runAlone(shown: SettlementPreview) {
    if (aloneBlocker !== null || !single || shown.pool.poolId !== poolId || !selectsOnly(shown.selection, single)) return;
    run.run(shown.selection);
  }

  function selectFamily(next: Family) {
    setFamily(next);
    setRetryOf(null);
  }

  function reviewRetry(batch: Settlement) {
    const type = batch.requests[0]?.type;
    if (!type) return;
    setFamily(type);
    setRetryOf(batch.settlementId);
  }

  function open(row: QueueRow, button: HTMLElement) {
    trigger.current = button;
    setSelected(row);
  }

  // The Details button is gone once its row leaves the queue; the search field stays put.
  function restoreFocus() {
    const target = trigger.current?.isConnected ? trigger.current : document.getElementById(searchId);
    target?.focus();
  }

  const info = familyInfo(family);
  const labels = {
    baseLabel: pool.settings.baseInstrumentId.id,
    quoteLabel: pool.settings.quoteInstrumentId.id,
  };
  const holdProps = {
    holding,
    // The venue refuses every hold change while a batch is in flight.
    holdsLocked: inFlight !== null,
    busy,
    now,
  };

  return (
    <>
      <PoolState pool={pool} monitoring={monitoring.data} now={now} />

      {monitoring.error && monitoring.data !== undefined ? (
        <RefreshFailure error={monitoring.error} onRetry={monitoring.reload} />
      ) : null}

      <QueueOverview
        summaries={summaries}
        policies={settings.policies}
        family={family}
        onSelect={selectFamily}
        now={now}
      />

      <BatchPreview
        // A new queue or a new retry starts with nothing pinned.
        key={`${family}:${retryOf ?? ''}`}
        regionId={previewId}
        family={info}
        retryOf={retryOf}
        preview={preview}
        rows={familyRows}
        batchSize={settings.current.data?.batchSize}
        labels={{ ...labels, lp: pool.settings.lpTokenInstrumentId }}
        inFlight={inFlight}
        run={run}
        busy={hold.pending || settings.saving}
        holding={holding}
        holdsLocked={holdProps.holdsLocked}
        holdError={hold.error}
        now={now}
        onDefer={(request) => void changeHold(request, true)}
        onOpen={open}
        onExitRetry={() => setRetryOf(null)}
      />

      <DeferredList
        family={info}
        rows={familyRows?.filter((row) => row.deferred) ?? []}
        {...holdProps}
        onReturn={(request) => void changeHold(request, false)}
        onOpen={open}
      />

      <QueueTable
        family={info}
        actions={
          <>
            <QueueSettings family={info} settings={settings} busy={hold.pending || run.pending} />
            <RunBatch
              blocker={blocker}
              pending={run.pending}
              size={preview.data?.selection.requests.length ?? 0}
              previewId={previewId}
              onRun={() => preview.data && runPreviewed(preview.data)}
            />
          </>
        }
        queue={queue}
        rows={familyRows?.filter((row) => !row.deferred)}
        monitoring={monitoring.data}
        view={view}
        onView={setView}
        search={search}
        onSearch={setSearch}
        searchId={searchId}
        onOpen={open}
        {...holdProps}
        onDefer={(request) => void changeHold(request, true)}
      />

      <BatchHistory
        history={history}
        labels={labels}
        currentStateId={monitoring.data?.pool.reserves.stateId ?? null}
        reviewing={retryOf}
        onReviewRetry={reviewRetry}
        now={now}
      />

      <RequestDetail
        row={selected}
        left={selected !== undefined && rows !== undefined && live === undefined}
        batches={knownBatches}
        now={now}
        notices={<RunNotices run={run} inFlight={pendingRequest ?? inFlight} now={now} />}
        action={
          waiting ? (
              <RunRequest
                preview={alone}
                blocker={aloneBlocker}
                pending={run.pending}
                lp={pool.settings.lpTokenInstrumentId}
                onRun={() => alone.data && runAlone(alone.data)}
              />
          ) : undefined
        }
        onClose={() => setSelected(undefined)}
        onCloseAutoFocus={restoreFocus}
      />
    </>
  );
}
