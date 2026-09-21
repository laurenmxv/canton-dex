import {
  Banner,
  CardContent,
  Checkbox,
  Input,
  Label,
  LoadingButton as Button,
} from '@openzeppelin/ui-components';
import { useState } from 'react';
import { useDexClient, useSession } from '../../app/runtime';
import { useAction, type AsyncResult } from '../../app/useAsync';
import { errorCode, type SettlementMonitoring, type SettlementPolicy } from '../../lib/api/types';
import { claimRunKey, outstandingRunKey, resolveRunKey } from '../../lib/runKey';
import { Mono } from '../../ui/Mono';
import { TextLink } from '../../ui/Link';
import { StatusBadge } from '../../ui/Badge';
import { Card, CardHeader } from '../../ui/Card';
import { AsyncSection } from '../../ui/States';

/**
 * One pool's batching settings and the two commands that act on it.
 *
 * Every setting belongs to this pool: there is no venue-wide target and no
 * venue-wide switch. What is shown is what the venue's database answered, so a
 * reload shows the saved settings rather than anything this browser kept.
 */
/**
 * The batch-size slider.
 *
 * The kit has no slider: `NumberField` is the nearest thing it exports, and it
 * draws a text input. The exact value beside this one is that field's job; this
 * is the coarse control, so it stays a native range with the kit's own frame.
 */
const SLIDER =
  'border-input bg-card accent-primary h-10 w-full rounded-md border px-0 text-sm transition-colors focus-visible:border-primary focus-visible:ring-primary/20 focus-visible:ring-3 focus-visible:outline-none';

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
            <StatusBadge tone={policy.data.automaticEnabled ? 'progress' : 'neutral'} dot={policy.data.automaticEnabled} label={policy.data.automaticEnabled ? 'Automatic' : 'Manual'} />
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
    <CardContent className="p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[0.9375rem] font-semibold tracking-[-0.01em]">
            Ready {monitoring?.readyCount ?? '—'} / {saved.batchSize}
          </p>
          {/* The badge above reports the saved mode; this marks a draft that
              has not reached the venue. */}
          {changed ? (
            <p className="text-muted-foreground mt-0.5 text-xs">Unsaved changes</p>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
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

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium" htmlFor={`batch-size-${poolId}`}>
            Batch target
          </Label>
          <input
            id={`batch-size-${poolId}`}
            className={SLIDER}
            type="range"
            min={1}
            max={saved.maxBatchSize}
            step={1}
            value={batchSize}
            disabled={busy}
            onChange={(event) => setTyped(String(proposeBatchSize(Number(event.target.value))))}
          />
          <p className="text-muted-foreground text-[0.75rem]" id={`batch-size-${poolId}-hint`}>
            1 to {saved.maxBatchSize}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium" htmlFor={`batch-size-exact-${poolId}`}>
            Batch target, exact
          </Label>
          <Input
            id={`batch-size-exact-${poolId}`}
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

      <div className="flex items-center gap-3">
        <Label className="flex items-center gap-3" htmlFor={`automatic-${poolId}`}>
          <Checkbox
            id={`automatic-${poolId}`}
            role="switch"
            checked={automaticEnabled}
            disabled={busy}
            onCheckedChange={(next) => setAutomaticEnabled(next === true)}
          />
          <span>Automatic settlement</span>
        </Label>
      </div>

      {stale ? (
        <Banner variant="warning" title="These settings changed elsewhere" size="compact" dismissible={false}>
          <TextLink onClick={onReload}>Reload settings</TextLink>
        </Banner>
      ) : save.error ? (
        <Banner variant="error" size="compact" dismissible={false}>{save.error.message}</Banner>
      ) : null}

      {outstanding ? (
        <Banner variant="warning" title="Batch status unknown" size="compact" dismissible={false}>
          {run.error ? `${run.error.message} ` : ''}
          <Mono>{outstanding}</Mono>
        </Banner>
      ) : run.error ? (
        <Banner variant="error" size="compact" dismissible={false}>{run.error.message}</Banner>
      ) : null}

      <div className="flex items-center gap-3">
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
        <span className="text-muted-foreground text-xs">Saved version {saved.version}</span>
      </div>
    </CardContent>
  );
}
