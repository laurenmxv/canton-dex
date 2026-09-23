import { Button } from '@openzeppelin/ui-components';
import { cn } from '@openzeppelin/ui-utils';
import { formatCountdown } from '../../lib/labels';
import {
  DEADLINE_ELAPSED,
  deadlineUrgency,
  FAMILIES,
  holdLabels,
  type Family,
  type FamilySummary,
} from './queueRows';

function Count({ label, value, warn = false }: { label: string; value: number; warn?: boolean }) {
  return (
    <span className="flex flex-col">
      <span className="text-muted-foreground text-[0.6875rem]">{label}</span>{' '}
      <span
        className={cn(
          'text-sm font-medium tabular-nums',
          warn && value > 0 && 'font-semibold text-[color:var(--warning)]',
        )}
      >
        {value}
      </span>
    </span>
  );
}

/** The pool's three queues at a glance. Choosing one opens its workspace below. */
export function QueueOverview({
  summaries,
  family,
  onSelect,
  now,
}: {
  /** Undefined until the queue has been read. */
  summaries: Record<Family, FamilySummary> | undefined;
  family: Family;
  onSelect: (family: Family) => void;
  now: number;
}) {
  return (
    <section aria-label="Queues" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {FAMILIES.map(({ type, noun, edge }) => {
        const summary = summaries?.[type];
        const deadline = summary?.nearestDeadline ?? null;
        const urgency = deadline ? deadlineUrgency(deadline, now) : null;
        return (
          <Button
            key={type}
            type="button"
            variant="outline"
            aria-pressed={family === type}
            onClick={() => onSelect(type)}
            className={cn(
              'bg-card shadow-card aria-pressed:bg-primary-soft aria-pressed:border-primary-border h-auto flex-col items-stretch justify-start gap-2.5 rounded-lg border-l-4 px-4 py-3 text-left font-normal whitespace-normal',
              edge,
            )}
          >
            <span className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground text-xs font-semibold tracking-[0.04em] uppercase">
                {noun}
              </span>
              <span className="flex items-baseline gap-1.5">
                <span className="text-foreground text-2xl leading-none font-semibold tabular-nums">
                  {summary ? summary.ready : '—'}
                </span>{' '}
                <span className="text-muted-foreground text-xs">ready</span>
              </span>
            </span>
            {summary && summary.outstanding > 0 ? (
              <>
                <span className="grid grid-cols-3 gap-2">
                  <Count label="Attention" value={summary.attention} warn />
                  <Count label={holdLabels.deferred} value={summary.deferred} />
                  <Count label="In flight" value={summary.inFlight} />
                </span>
                <span
                  className={cn(
                    'text-xs tabular-nums',
                    urgency ? 'font-semibold text-[color:var(--warning)]' : 'text-muted-foreground',
                  )}
                >
                  {deadline === null
                    ? null
                    : urgency === 'passed'
                      ? DEADLINE_ELAPSED
                      : `Next deadline in ${formatCountdown(deadline, now)}`}
                </span>
              </>
            ) : summary ? (
              <span className="text-muted-foreground text-xs">Empty</span>
            ) : null}
          </Button>
        );
      })}
    </section>
  );
}
