import { Badge } from '@openzeppelin/ui-components';
import type { Tone } from '../lib/labels';

/** Each venue tone on the nearest tone the kit draws. */
const ozTone = {
  neutral: 'neutral',
  progress: 'info',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
} as const;

/**
 * A dot that keeps beating while the ledger works.
 *
 * It is the one part of a status a reader watches rather than reads, so it
 * says "still going" without a word. Reduced motion settles it.
 */
function PulsingDot() {
  return (
    <span
      aria-hidden="true"
      className="size-1.5 flex-none animate-pulse rounded-full bg-current"
    />
  );
}

function Dot() {
  return <span aria-hidden="true" className="size-1.5 flex-none rounded-full bg-current" />;
}

/**
 * What a record's state looks like on screen.
 *
 * OpenZeppelin's badge carries four of this venue's five tones. The fifth,
 * `progress`, is the brand violet with a beating dot, and it marks the states
 * where the ledger is still working. A trader reads it as "not settled yet",
 * so it stays.
 */
export function StatusBadge({
  tone = 'neutral',
  dot = false,
  label,
}: {
  tone?: Tone;
  dot?: boolean;
  label: string;
}) {
  const working = tone === 'progress';
  return (
    <Badge
      tone={ozTone[tone]}
      label={label}
      className={
        working ? 'bg-primary-soft text-primary border-primary-border' : undefined
      }
      icon={dot ? working ? <PulsingDot /> : <Dot /> : undefined}
    />
  );
}
