import { useState } from 'react';
import { useDexClient, useSession } from '../../app/runtime';
import { useAction, type AsyncResult } from '../../app/useAsync';
import { errorCode, type SettlementMonitoring, type SettlementPolicy } from '../../lib/api/types';
import { claimRunKey, outstandingRunKey, resolveRunKey } from '../../lib/runKey';
import { Badge, Callout } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { AsyncSection } from '../../ui/States';

/**
 * One pool's batching settings and the two commands that act on it.
 *
 * Every setting belongs to this pool: there is no venue-wide target and no
 * venue-wide switch. What is shown is what the venue's database answered, so a
 * reload shows the saved settings rather than anything this browser kept.
 */
export function PolicyControls({
  poolId,
  policy,
  monitoring,
  onChanged,
}: {
  poolId: string;
  policy: AsyncResult<SettlementPolicy>;
  monitoring: SettlementMonitoring | undefined;
  onChanged: () => void;
}) {
  return (
    <Card>
      <CardHeader
        title="Settlement"
        actions={
          policy.data ? (
            <Badge tone={policy.data.automaticEnabled ? 'progress' : 'neutral'} dot={policy.data.automaticEnabled}>
              {policy.data.automaticEnabled ? 'Automatic' : 'Manual'}
            </Badge>
          ) : null
        }
      />
      <AsyncSection result={policy} label="Loading this pool's settings" rows={2}>
        {(saved) => (
          <PolicyEditor
            // A freshly loaded version replaces the draft, so a saved change
            // or another operator's change is what the form starts from.
            key={`${poolId}:${saved.version}`}
            poolId={poolId}
            saved={saved}
            monitoring={monitoring}
            onReload={policy.reload}
            onChanged={onChanged}
          />
        )}
      </AsyncSection>
    </Card>
  );
}

function PolicyEditor({
  poolId,
  saved,
  monitoring,
  onReload,
  onChanged,
}: {
  poolId: string;
  saved: SettlementPolicy;
  monitoring: SettlementMonitoring | undefined;
  onReload: () => void;
  onChanged: () => void;
}) {
  const client = useDexClient();
  // An outstanding run belongs to the operator who started it, not to whoever
  // is looking at this pool now.
  const accountId = useSession().current?.accountId ?? 'anonymous';
  const [batchSize, setBatchSize] = useState(saved.batchSize);
  const [automaticEnabled, setAutomaticEnabled] = useState(saved.automaticEnabled);
  /**
   * What the exact field shows while it is being typed in. It can hold what a
   * target cannot, such as nothing at all, so the field can be cleared and
   * retyped; only a whole number within the venue's bounds becomes the target.
   */
  const [typed, setTyped] = useState(String(saved.batchSize));

  function proposeBatchSize(next: number) {
    const bounded = Math.min(Math.max(Math.round(next), 1), saved.maxBatchSize);
    setBatchSize(bounded);
    return bounded;
  }

  const save = useAction(() =>
    client.admin.settlements.updatePolicy(poolId, {
      automaticEnabled,
      batchSize,
      expectedVersion: saved.version,
    }),
  );

  // Kept outside this form: saving settings replaces it and a reload destroys
  // it, while the run its key names stays outstanding through both.
  const [outstanding, setOutstanding] = useState(() => outstandingRunKey(accountId, poolId));
  const run = useAction(() => {
    const idempotencyKey = claimRunKey(accountId, poolId);
    setOutstanding(idempotencyKey);
    return client.admin.settlements.run(poolId, { idempotencyKey });
  });

  const stale = save.error !== undefined && errorCode(save.error) === 'CONFLICT';
  const changed = batchSize !== saved.batchSize || automaticEnabled !== saved.automaticEnabled;
  const busy = save.pending || run.pending;

  return (
    <div className="card-pad stack">
      <div className="row-between">
        <div>
          <p className="card-title">
            Ready {monitoring?.readyCount ?? '—'} / {saved.batchSize}
          </p>
          {/* The badge above reports the saved mode; this marks a draft that
              has not reached the venue. */}
          {changed ? <p className="card-desc">Unsaved changes</p> : null}
        </div>
        <div className="row">
          <Button
            variant="secondary"
            size="sm"
            loading={run.pending}
            disabled={busy}
            onClick={async () => {
              const batch = await run.perform();
              // A reply for another pool cannot be this pool's answer.
              if (batch?.poolId !== poolId) return;
              // The venue has now named the batch this key made, whatever its
              // status, so the key has done its work.
              resolveRunKey(accountId, poolId);
              setOutstanding(undefined);
              onChanged();
            }}
          >
            Run batch
          </Button>
        </div>
      </div>

      <div className="grid-2">
        <div className="field">
          <label className="field-label" htmlFor={`batch-size-${poolId}`}>
            Batch target
          </label>
          <input
            id={`batch-size-${poolId}`}
            className="control"
            type="range"
            min={1}
            max={saved.maxBatchSize}
            step={1}
            value={batchSize}
            disabled={busy}
            onChange={(event) => setTyped(String(proposeBatchSize(Number(event.target.value))))}
          />
          <p className="field-hint" id={`batch-size-${poolId}-hint`}>
            1 to {saved.maxBatchSize}
          </p>
        </div>
        <div className="field">
          <label className="field-label" htmlFor={`batch-size-exact-${poolId}`}>
            Batch target, exact
          </label>
          <input
            id={`batch-size-exact-${poolId}`}
            className="control"
            type="number"
            inputMode="numeric"
            min={1}
            max={saved.maxBatchSize}
            value={typed}
            disabled={busy}
            onChange={(event) => {
              setTyped(event.target.value);
              const next = Number(event.target.value);
              if (event.target.value !== '' && Number.isFinite(next)) proposeBatchSize(next);
            }}
            onBlur={() => setTyped(String(batchSize))}
          />
        </div>
      </div>

      <div className="row">
        <label className="row" htmlFor={`automatic-${poolId}`}>
          <input
            id={`automatic-${poolId}`}
            type="checkbox"
            role="switch"
            checked={automaticEnabled}
            disabled={busy}
            onChange={(event) => setAutomaticEnabled(event.target.checked)}
          />
          <span>Automatic settlement</span>
        </label>
      </div>

      {stale ? (
        <Callout tone="warning" title="These settings changed elsewhere">
          <button type="button" className="table-link" onClick={onReload}>
            Reload settings
          </button>
        </Callout>
      ) : save.error ? (
        <Callout tone="danger">{save.error.message}</Callout>
      ) : null}

      {outstanding ? (
        <Callout tone="warning" title="Batch status unknown">
          {run.error ? `${run.error.message} ` : ''}
          <span className="mono">{outstanding}</span>
        </Callout>
      ) : run.error ? (
        <Callout tone="danger">{run.error.message}</Callout>
      ) : null}

      <div className="row">
        <Button
          size="sm"
          loading={save.pending}
          disabled={busy || !changed}
          onClick={async () => {
            const committed = await save.perform();
            if (committed?.poolId !== poolId) return;
            onReload();
            onChanged();
          }}
        >
          Save settings
        </Button>
        <span className="muted text-xs">Saved version {saved.version}</span>
      </div>
    </div>
  );
}
