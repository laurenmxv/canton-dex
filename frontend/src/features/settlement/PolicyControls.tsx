import {
  Banner,
  CardContent,
  Checkbox,
  Input,
  Label,
  LoadingButton as Button,
} from '@openzeppelin/ui-components';
import { useState } from 'react';
import type { ActionResult, AsyncResult } from '../../app/useAsync';
import {
  errorCode,
  type SettlementPolicy,
  type UpdateSettlementPolicy,
} from '../../lib/api/types';
import { TextLink } from '../../ui/Link';
import { StatusBadge } from '../../ui/Badge';
import { Card, CardHeader } from '../../ui/Card';
import { Disclosure } from '../../ui/Disclosure';
import { AsyncSection } from '../../ui/States';

/**
 * The batch-size slider.
 *
 * The kit has no slider: `NumberField` is the nearest thing it exports, and it
 * draws a text input. The exact value beside this one is that field's job; this
 * is the coarse control, so it stays a native range with the kit's own frame.
 */
const SLIDER =
  'border-input bg-card accent-primary h-10 w-full rounded-md border px-0 text-sm transition-colors focus-visible:border-primary focus-visible:ring-primary/20 focus-visible:ring-3 focus-visible:outline-none';

/**
 * One pool's saved dispatch mode, and the less frequent policy editing behind
 * a disclosure. What is shown is what the venue's database answered, never
 * anything this browser kept.
 */
export function PolicyControls({
  poolId,
  policy,
  save,
  busy,
  onSaved,
}: {
  poolId: string;
  policy: AsyncResult<SettlementPolicy>;
  /**
   * Held by the screen rather than the form, so folding the settings away
   * cannot drop a pending save, and a run cannot start while one is pending.
   */
  save: ActionResult<[UpdateSettlementPolicy], SettlementPolicy>;
  /** A run or a hold is waiting for its answer. */
  busy: boolean;
  onSaved: () => void;
}) {
  const saved = policy.data;

  async function saveSettings(input: UpdateSettlementPolicy) {
    const committed = await save.perform(input);
    if (committed?.poolId !== poolId) return;
    onSaved();
  }

  return (
    <Card>
      <CardHeader
        title="Policy"
        actions={
          saved ? (
            <StatusBadge
              tone={saved.automaticEnabled ? 'progress' : 'neutral'}
              dot={saved.automaticEnabled}
              label={saved.automaticEnabled ? 'Automatic' : 'Manual'}
            />
          ) : null
        }
      />
      <CardContent className="p-4">
        <Disclosure
          summary={saved ? `Policy settings · batch size ${saved.batchSize}` : 'Policy settings'}
        >
          <AsyncSection result={policy} label="Loading this pool's settings" rows={2}>
            {(current) => (
              <PolicyForm
                // A freshly loaded version replaces the draft, so a saved change
                // or another operator's change is what the form starts from.
                key={`${poolId}:${current.version}`}
                poolId={poolId}
                saved={current}
                busy={busy || save.pending}
                saving={save.pending}
                error={save.error}
                onSave={saveSettings}
                onReload={() => {
                  save.clearError();
                  policy.reload();
                }}
              />
            )}
          </AsyncSection>
        </Disclosure>
      </CardContent>
    </Card>
  );
}

function PolicyForm({
  poolId,
  saved,
  busy,
  saving,
  error,
  onSave,
  onReload,
}: {
  poolId: string;
  saved: SettlementPolicy;
  /** A save or a run is in flight. */
  busy: boolean;
  saving: boolean;
  error: Error | undefined;
  onSave: (input: UpdateSettlementPolicy) => void;
  onReload: () => void;
}) {
  const [batchSize, setBatchSize] = useState(saved.batchSize);
  const [automaticEnabled, setAutomaticEnabled] = useState(saved.automaticEnabled);
  /**
   * What the exact field shows while it is being typed in. It can hold what a
   * batch size cannot, such as nothing at all, so the field can be cleared and
   * retyped; only a whole number within the venue's bounds becomes the batch size.
   */
  const [typed, setTyped] = useState(String(saved.batchSize));

  function proposeBatchSize(next: number) {
    const bounded = Math.min(Math.max(Math.round(next), 1), saved.maxBatchSize);
    setBatchSize(bounded);
    return bounded;
  }

  const stale = error !== undefined && errorCode(error) === 'CONFLICT';
  const changed = batchSize !== saved.batchSize || automaticEnabled !== saved.automaticEnabled;

  return (
    <div className="flex flex-col gap-4 pt-1 text-sm">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium" htmlFor={`batch-size-${poolId}`}>
            Batch size
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
          <p className="text-muted-foreground text-[0.75rem]">
            1 to {saved.maxBatchSize} swaps, proportional deposits or withdrawals. Initial deposits
            settle one at a time.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium" htmlFor={`batch-size-exact-${poolId}`}>
            Batch size, exact
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

      {stale ? (
        <Banner variant="warning" title="These settings changed elsewhere" size="compact" dismissible={false}>
          <TextLink onClick={onReload}>Reload settings</TextLink>
        </Banner>
      ) : error ? (
        <Banner variant="error" size="compact" dismissible={false}>
          {error.message}
        </Banner>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          loading={saving}
          disabled={busy || !changed}
          onClick={() => onSave({ automaticEnabled, batchSize, expectedVersion: saved.version })}
        >
          Save settings
        </Button>
        {/* The badge above reports the saved mode; this marks a draft that
            has not reached the venue. */}
        {changed ? <span className="text-muted-foreground text-xs">Unsaved changes</span> : null}
        <span className="text-muted-foreground text-xs">Saved version {saved.version}</span>
      </div>
    </div>
  );
}
