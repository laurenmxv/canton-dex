import { LoadingButton as Button } from '@openzeppelin/ui-components';
import { useId } from 'react';
import { TextLink } from '../../ui/Link';

/**
 * Runs the batch the preview shows, and no other.
 *
 * It sits in the queue's own panel, away from the steps it would send. It says
 * how many requests it would send, or why it cannot, and that status leads
 * back to the preview.
 */
export function RunBatch({
  blocker,
  pending,
  size,
  previewId,
  onRun,
}: {
  /** Why the preview on screen cannot run now, or null when it can. */
  blocker: string | null;
  pending: boolean;
  /** How many requests the preview on screen would send. */
  size: number;
  /** The preview's region, where every step can be checked. */
  previewId: string;
  onRun: () => void;
}) {
  const statusId = useId();
  // A run in flight shows its own spinner, so it needs no status beside it.
  const status = pending ? null : (blocker ?? `${size} in the next batch`);

  return (
    <>
      {status ? (
        <span id={statusId}>
          <TextLink
            className="text-muted-foreground text-xs"
            onClick={() => document.getElementById(previewId)?.focus()}
          >
            {status}
          </TextLink>
        </span>
      ) : null}
      <Button
        size="sm"
        loading={pending}
        disabled={blocker !== null}
        aria-describedby={status ? statusId : undefined}
        onClick={onRun}
      >
        Run batch
      </Button>
    </>
  );
}
