import { LoadingButton as Button } from '@openzeppelin/ui-components';
import { useId } from 'react';
import type { InstrumentId } from '../../lib/api/types';
import { StatusBadge } from '../../ui/Badge';
import { RefreshFailure } from '../../ui/States';
import { ProjectedOutput } from './BatchPreview';
import { stepStateLabels, stepStateOf, stepStateTones } from './preview';
import type { PreviewRead } from './usePreview';

/**
 * Runs one request alone, as a batch of one, from its own preview.
 *
 * The preview projects this request by itself, so it can run ahead of the
 * requests before it, but never ahead of the checks every batch faces. What it
 * shows is a projection: only a confirmed batch settles anything.
 */
export function RunRequest({
  preview,
  blocker,
  pending,
  lp,
  onRun,
}: {
  /** The preview of this request alone. */
  preview: PreviewRead;
  /** Why the request cannot run alone now, or null when it can. */
  blocker: string | null;
  pending: boolean;
  lp: InstrumentId;
  onRun: () => void;
}) {
  const reasonId = useId();
  const step = preview.data?.steps[0];
  const state = step && stepStateOf(step);
  // A run in flight shows its own spinner, so it needs no reason beside it.
  const reason = pending ? null : blocker;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        {step && state ? (
          <span className="flex flex-wrap items-center gap-2 text-xs tabular-nums">
            <StatusBadge tone={stepStateTones[state]} label={stepStateLabels[state]} />
            {step.outputs.map((check) => (
              <ProjectedOutput
                key={`${check.instrument.admin}:${check.instrument.id}`}
                check={check}
                state={state}
                lp={lp}
              />
            ))}
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-3">
          {reason ? (
            <span id={reasonId} className="text-muted-foreground text-xs">
              {reason}
            </span>
          ) : null}
          <Button
            size="sm"
            loading={pending}
            disabled={blocker !== null}
            aria-describedby={reason ? reasonId : undefined}
            onClick={onRun}
          >
            Run request
          </Button>
        </span>
      </div>
      {step?.error ? <p className="text-destructive text-xs">{step.error}</p> : null}
      {preview.error ? <RefreshFailure error={preview.error} onRetry={preview.reload} /> : null}
    </div>
  );
}
