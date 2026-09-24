import {
  Banner,
  Button,
  Checkbox,
  Input,
  Label,
  LoadingButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@openzeppelin/ui-components';
import { useId, useState } from 'react';
import { errorCode, type SettlementPolicy, type UpdateSettlementPolicy } from '../../lib/api/types';
import { StatusBadge } from '../../ui/Badge';
import { TextLink } from '../../ui/Link';
import { AsyncSection } from '../../ui/States';
import type { Family, FamilyInfo } from './queueRows';
import type { QueuePolicy } from './useQueuePolicy';

/**
 * The batch-size slider.
 *
 * The kit has no slider: `NumberField` is the nearest thing it exports, and it
 * draws a text input. The exact value beside this one is that field's job; this
 * is the coarse control, so it stays a native range with the kit's own frame.
 */
const SLIDER =
  'border-input bg-card accent-primary h-10 w-full min-w-0 rounded-md border px-0 text-sm transition-colors focus-visible:border-primary focus-visible:ring-primary/20 focus-visible:ring-3 focus-visible:outline-none';

/**
 * What a batch size means for each queue beyond its bounds. Only an automatic
 * swap batch waits to fill; deposits and withdrawals promise no such wait.
 */
const BATCH_NOTES: Record<Family, string | null> = {
  swap: 'Automatic batches wait for a full batch.',
  deposit: 'Initial deposits settle one at a time.',
  withdraw: null,
};

const SETTINGS = 'Settings';

function modeLabel(automatic: boolean): string {
  return automatic ? 'Automatic' : 'Manual';
}

/** A queue's saved dispatch mode, never the draft being edited. */
export function ModeBadge({ automatic }: { automatic: boolean }) {
  return <StatusBadge tone={automatic ? 'progress' : 'neutral'} label={modeLabel(automatic)} />;
}

/**
 * One queue's saved mode and batch size, and the form that changes them.
 *
 * What the trigger reports is the newest settings the venue confirmed for this
 * queue. The form opens over the queue's panel and edits nothing else.
 */
export function QueueSettings({
  family,
  settings,
  busy,
}: {
  family: FamilyInfo;
  settings: QueuePolicy;
  /** A run or a hold is waiting for its answer. */
  busy: boolean;
}) {
  const saved = settings.current.data;
  const summary = saved ? `${modeLabel(saved.automaticEnabled)} · ${saved.batchSize} per batch` : undefined;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" aria-label={summary ? `${SETTINGS}: ${summary}` : SETTINGS}>
          {summary ?? SETTINGS}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label={`${family.noun} settings`} className="w-80">
        <AsyncSection result={settings.current} label="Loading this queue's settings" rows={2}>
          {(current) => (
            <SettingsForm
              // A new version replaces the draft, so a saved change or another
              // operator's change is what the form starts from.
              key={`${current.type}:${current.version}`}
              saved={current}
              busy={busy || settings.saving}
              saving={settings.saving}
              error={settings.error}
              onSave={settings.save}
              onReload={settings.reread}
            />
          )}
        </AsyncSection>
      </PopoverContent>
    </Popover>
  );
}

function SettingsForm({
  saved,
  busy,
  saving,
  error,
  onSave,
  onReload,
}: {
  saved: SettlementPolicy;
  /** A save, a run or a hold is waiting for its answer. */
  busy: boolean;
  saving: boolean;
  error: Error | undefined;
  onSave: (input: UpdateSettlementPolicy) => void;
  onReload: () => void;
}) {
  const id = useId();
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
  const note = BATCH_NOTES[saved.type];

  return (
    <div className="flex flex-col gap-4 text-sm">
      <Label className="flex items-center gap-3" htmlFor={`${id}-automatic`}>
        <Checkbox
          id={`${id}-automatic`}
          role="switch"
          checked={automaticEnabled}
          disabled={busy}
          onCheckedChange={(next) => setAutomaticEnabled(next === true)}
        />
        <span>Automatic settlement</span>
      </Label>

      <div className="flex flex-col gap-1.5">
        <Label className="text-xs font-medium" htmlFor={`${id}-size`}>
          Batch size
        </Label>
        <div className="flex items-center gap-2">
          <input
            id={`${id}-size`}
            className={SLIDER}
            type="range"
            min={1}
            max={saved.maxBatchSize}
            step={1}
            value={batchSize}
            disabled={busy}
            aria-describedby={`${id}-bounds`}
            onChange={(event) => setTyped(String(proposeBatchSize(Number(event.target.value))))}
          />
          <Label className="sr-only" htmlFor={`${id}-exact`}>
            Batch size, exact
          </Label>
          <Input
            id={`${id}-exact`}
            className="w-16 flex-none"
            type="number"
            inputMode="numeric"
            min={1}
            max={saved.maxBatchSize}
            value={typed}
            disabled={busy}
            aria-describedby={`${id}-bounds`}
            onChange={(event) => {
              setTyped(event.target.value);
              const next = Number(event.target.value);
              if (event.target.value !== '' && Number.isFinite(next)) proposeBatchSize(next);
            }}
            onBlur={() => setTyped(String(batchSize))}
          />
        </div>
        <p id={`${id}-bounds`} className="text-muted-foreground text-[0.75rem]">
          1 to {saved.maxBatchSize}.{note ? ` ${note}` : null}
        </p>
      </div>

      {stale ? (
        <Banner variant="warning" title="These settings changed elsewhere" size="compact" dismissible={false}>
          <TextLink onClick={onReload}>Reload settings</TextLink>
        </Banner>
      ) : error ? (
        <Banner variant="error" size="compact" dismissible={false}>
          {error.message}
        </Banner>
      ) : null}

      <div className="flex justify-end">
        <LoadingButton
          size="sm"
          loading={saving}
          disabled={busy || !changed}
          onClick={() => onSave({ automaticEnabled, batchSize, expectedVersion: saved.version })}
        >
          Save settings
        </LoadingButton>
      </div>
    </div>
  );
}
