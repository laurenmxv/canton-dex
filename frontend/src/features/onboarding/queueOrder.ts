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

/**
 * The queue in the order the operator asked for.
 *
 * Text is compared the way a reader reads it, so case and accents do not split
 * names that belong together. A tie falls back to the newest first, and then to
 * the identifier, so the order never shifts between two identical readings.
 */
export function orderQueue(requests: readonly Onboarding[], order: QueueOrder): Onboarding[] {
  const compare = new Intl.Collator('en', { sensitivity: 'base', numeric: true }).compare;
  const sign = order.direction === 'ascending' ? 1 : -1;

  return [...requests].sort((left, right) => {
    const ranked = compare(keyOf(left, order.column), keyOf(right, order.column));
    if (ranked !== 0) return ranked * sign;
    if (order.column !== 'submitted') {
      const byDate = compare(left.createdAt, right.createdAt);
      if (byDate !== 0) return -byDate;
    }
    return compare(left.id, right.id);
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
