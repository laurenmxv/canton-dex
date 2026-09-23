import { LoadingButton as Button } from '@openzeppelin/ui-components';
import type { SettlementRequestRef } from '../../lib/api/types';
import { formatCountdown, shortContract, shortParty } from '../../lib/labels';
import { deadlineUrgency, holdLabels, type QueueRow } from './queueRows';

/**
 * The parts every list of queued requests shares: the queue itself, the
 * deferred list and the next batch all name a request, time it and act on it
 * the same way.
 */

/** A request as every list here names it: its id, and the trader under it. */
export function RequestCell({ row }: { row: QueueRow }) {
  return (
    <span className="flex flex-col font-mono text-xs">
      {shortContract(row.requestId)}
      <span className="text-muted-foreground">{shortParty(row.trader)}</span>
    </span>
  );
}

export function Deadline({ deadline, now }: { deadline: string; now: number }) {
  const urgency = deadlineUrgency(deadline, now);
  if (urgency === 'passed') return <span className="text-destructive font-medium">Elapsed</span>;
  return (
    <span className={urgency === 'soon' ? 'font-semibold text-[color:var(--warning)]' : undefined}>
      {formatCountdown(deadline, now)}
    </span>
  );
}

/** Opens the request's full detail, which returns focus here on close. */
export function DetailsButton({
  row,
  onOpen,
}: {
  row: QueueRow;
  onOpen: (row: QueueRow, trigger: HTMLElement) => void;
}) {
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label={`Details for request ${shortContract(row.requestId)}`}
      onClick={(event) => onOpen(row, event.currentTarget)}
    >
      Details
    </Button>
  );
}

/** Holds the request back from batches. The caller decides whether the venue would accept that now. */
export function DeferButton({
  row,
  holding,
  disabled,
  onDefer,
}: {
  row: QueueRow;
  holding: string | undefined;
  disabled: boolean;
  onDefer: (request: SettlementRequestRef) => void;
}) {
  return (
    <Button
      size="sm"
      variant="ghost"
      loading={holding === row.requestId}
      disabled={disabled}
      aria-label={`${holdLabels.defer} request ${shortContract(row.requestId)}`}
      onClick={() => onDefer({ type: row.family, requestId: row.requestId })}
    >
      {holdLabels.defer}
    </Button>
  );
}
