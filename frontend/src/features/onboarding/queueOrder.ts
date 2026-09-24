import type { Onboarding } from '../../lib/api/types';
import { onboardingStatusLabels } from '../../lib/labels';

/** The columns the operator can order the queue by. */
export type QueueColumn = 'applicant' | 'country' | 'submitted' | 'status';

export type SortDirection = 'ascending' | 'descending';

export interface QueueOrder {
  column: QueueColumn;
  direction: SortDirection;
}

/** Newest first: the request an operator most likely came here for. */
export const DEFAULT_ORDER: QueueOrder = { column: 'submitted', direction: 'descending' };

/** What each column sorts on, in the form the reader sees it. */
function keyOf(onboarding: Onboarding, column: QueueColumn): string {
  switch (column) {
    case 'applicant':
      return onboarding.application.legalName;
    case 'country':
      return onboarding.application.countryCode;
    case 'submitted':
      return onboarding.createdAt;
    case 'status':
      return onboardingStatusLabels[onboarding.status];
  }
}

/** Rebuilt on every poll otherwise, and it is stateless. */
const COLLATOR = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/**
 * One instant as two comparable parts: the whole seconds, then the fraction.
 *
 * The venue serialises `createdAt` with up to nanosecond precision, and
 * without a fraction when it is zero. So
 * one list holds `…:00Z` beside `…:00.500Z` beside `…:00.500001Z`. `Date.parse`
 * stops at the millisecond, and comparing the text collates `.5` above `.25`,
 * so neither answers alone.
 */
function instantParts(text: string): [number, string] {
  const fraction = /\.(\d+)/.exec(text)?.[1] ?? '';
  return [Date.parse(text.replace(/\.\d+/, '')), fraction.padEnd(9, '0')];
}

/** Older first. Falls back to the text when the venue sent something unparsable. */
function compareInstants(left: string, right: string): number {
  const [leftSeconds, leftFraction] = instantParts(left);
  const [rightSeconds, rightFraction] = instantParts(right);
  if (Number.isNaN(leftSeconds) || Number.isNaN(rightSeconds)) {
    return COLLATOR.compare(left, right);
  }
  if (leftSeconds !== rightSeconds) return Math.sign(leftSeconds - rightSeconds);
  return leftFraction < rightFraction ? -1 : leftFraction > rightFraction ? 1 : 0;
}

/**
 * The queue in the order the operator asked for.
 *
 * A date is compared as an instant and text the way a reader reads it, so case
 * and accents do not split names that belong together. A tie falls back to the
 * newest first, and then to the identifier, so the order never shifts between
 * two identical readings.
 */
export function orderQueue(requests: readonly Onboarding[], order: QueueOrder): Onboarding[] {
  const sign = order.direction === 'ascending' ? 1 : -1;

  return [...requests].sort((left, right) => {
    const ranked =
      order.column === 'submitted'
        ? compareInstants(left.createdAt, right.createdAt)
        : COLLATOR.compare(keyOf(left, order.column), keyOf(right, order.column));
    if (ranked !== 0) return ranked * sign;
    if (order.column !== 'submitted') {
      const byDate = compareInstants(left.createdAt, right.createdAt);
      if (byDate !== 0) return -byDate;
    }
    return COLLATOR.compare(left.id, right.id);
  });
}

/**
 * Clicking a column sorts by it; clicking the one already sorted reverses it.
 *
 * A column the reader has just reached for starts in the direction that answers
 * the obvious question: newest first for a date, A to Z for a name.
 */
export function nextOrder(current: QueueOrder, column: QueueColumn): QueueOrder {
  if (current.column === column) {
    return {
      column,
      direction: current.direction === 'ascending' ? 'descending' : 'ascending',
    };
  }
  return { column, direction: column === 'submitted' ? 'descending' : 'ascending' };
}
