import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ORDER,
  nextOrder,
  orderQueue,
  type QueueColumn,
} from '../features/onboarding/queueOrder';
import type { Onboarding, OnboardingStatus } from '../lib/api/types';

function request(
  id: string,
  legalName: string,
  countryCode: string,
  createdAt: string,
  status: OnboardingStatus = 'AWAITING_REVIEW_AND_PARTY',
): Onboarding {
  return {
    id,
    accountId: `acc-${id}`,
    application: { legalName, countryCode, documents: [], documentReferences: [] },
    status,
    partyMode: 'external',
    createdAt,
    review: null,
    party: null,
    ledgerSteps: [],
    suggestedPartyHint: 'hint',
  };
}

const QUEUE = [
  request('b', 'Zephyr Markets', 'US', '2026-09-16T08:00:00Z', 'COMPLETED'),
  request('a', 'acme trading', 'PT', '2026-09-18T10:00:00Z', 'REJECTED'),
  request('c', 'Östra Capital', 'SE', '2026-09-17T09:00:00Z', 'AWAITING_REVIEW'),
];

const names = (order: Parameters<typeof orderQueue>[1]) =>
  orderQueue(QUEUE, order).map((one) => one.application.legalName);

describe('the queue an operator opens', () => {
  it('leads with the most recent request', () => {
    expect(DEFAULT_ORDER).toEqual({ column: 'submitted', direction: 'descending' });
    expect(names(DEFAULT_ORDER)).toEqual(['acme trading', 'Östra Capital', 'Zephyr Markets']);
  });

  it('leaves the list it was given alone', () => {
    const before = QUEUE.map((one) => one.id);
    orderQueue(QUEUE, { column: 'applicant', direction: 'ascending' });
    expect(QUEUE.map((one) => one.id)).toEqual(before);
  });
});

describe('ordering by a column', () => {
  it.each([
    ['applicant', ['acme trading', 'Östra Capital', 'Zephyr Markets']],
    ['country', ['acme trading', 'Östra Capital', 'Zephyr Markets']],
    ['submitted', ['Zephyr Markets', 'Östra Capital', 'acme trading']],
    ['status', ['Östra Capital', 'Zephyr Markets', 'acme trading']],
  ] as [QueueColumn, string[]][])('sorts by %s, ascending', (column, expected) => {
    expect(names({ column, direction: 'ascending' })).toEqual(expected);
  });

  it.each(['applicant', 'country', 'submitted', 'status'] as QueueColumn[])(
    'reverses %s exactly',
    (column) => {
      const up = names({ column, direction: 'ascending' });
      expect(names({ column, direction: 'descending' })).toEqual([...up].reverse());
    },
  );

  it('reads a name the way a person does, not the way bytes do', () => {
    // Lowercase and accented names sit where a reader expects them.
    expect(names({ column: 'applicant', direction: 'ascending' })[0]).toBe('acme trading');
  });

  it('breaks a tie the same way every time', () => {
    const tied = [
      request('second', 'Same Name', 'US', '2026-09-18T10:00:00Z'),
      request('first', 'Same Name', 'US', '2026-09-18T10:00:00Z'),
    ];
    const once = orderQueue(tied, { column: 'applicant', direction: 'ascending' });
    const twice = orderQueue([...tied].reverse(), { column: 'applicant', direction: 'ascending' });
    expect(once.map((one) => one.id)).toEqual(twice.map((one) => one.id));
  });

  it('falls back to the newest first when a column ties', () => {
    const tied = [
      request('old', 'Same Name', 'US', '2026-09-10T10:00:00Z'),
      request('new', 'Same Name', 'US', '2026-09-18T10:00:00Z'),
    ];
    expect(
      orderQueue(tied, { column: 'applicant', direction: 'ascending' }).map((one) => one.id),
    ).toEqual(['new', 'old']);
  });
});

describe('what a click on a heading does', () => {
  it('reverses the column already ordering the table', () => {
    expect(nextOrder({ column: 'applicant', direction: 'ascending' }, 'applicant')).toEqual({
      column: 'applicant',
      direction: 'descending',
    });
    expect(nextOrder({ column: 'applicant', direction: 'descending' }, 'applicant')).toEqual({
      column: 'applicant',
      direction: 'ascending',
    });
  });

  it('opens a date newest first, and a name from A', () => {
    expect(nextOrder({ column: 'applicant', direction: 'ascending' }, 'submitted')).toEqual({
      column: 'submitted',
      direction: 'descending',
    });
    expect(nextOrder(DEFAULT_ORDER, 'applicant')).toEqual({
      column: 'applicant',
      direction: 'ascending',
    });
  });
});
