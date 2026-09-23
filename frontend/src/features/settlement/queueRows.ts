import type { SettlementRequest, SettlementRequestRef } from '../../lib/api/types';
import { formatExact } from '../../lib/decimal';
import {
  liquidityStatusLabels,
  liquidityStatusTones,
  swapStatusLabels,
  swapStatusTones,
  type Tone,
} from '../../lib/labels';

export type Family = SettlementRequest['type'];

export interface FamilyInfo {
  type: Family;
  /** What the family is called on its card and in the workspace. */
  noun: string;
  /** The heading of the family's own queue. */
  title: string;
  /** One restrained accent per family, from the theme's own tokens. */
  dot: string;
  edge: string;
}

export const FAMILIES: readonly FamilyInfo[] = [
  { type: 'swap', noun: 'Swaps', title: 'Swap queue', dot: 'bg-primary', edge: 'border-l-primary' },
  {
    type: 'deposit',
    noun: 'Add liquidity',
    title: 'Add liquidity queue',
    dot: 'bg-[var(--success)]',
    edge: 'border-l-[color:var(--success)]',
  },
  {
    type: 'withdraw',
    noun: 'Withdraw liquidity',
    title: 'Withdraw liquidity queue',
    dot: 'bg-[var(--info)]',
    edge: 'border-l-[color:var(--info)]',
  },
];

export function familyInfo(type: Family): FamilyInfo {
  return FAMILIES.find((family) => family.type === type)!;
}

/** Where an active request stands for the operator. */
export type Stage = 'ready' | 'inFlight' | 'blocked' | 'other';

const STAGES: Record<string, Stage> = {
  READY: 'ready',
  BLOCKED: 'blocked',
  SUBMITTING: 'inFlight',
  UNRESOLVED: 'inFlight',
  SETTLING: 'inFlight',
  WITHDRAWING: 'inFlight',
  WITHDRAWAL_UNRESOLVED: 'inFlight',
  RECOVERING: 'inFlight',
  RECOVERY_UNRESOLVED: 'inFlight',
};

/** One queued request, read the same way whichever family it belongs to. */
export interface QueueRow {
  entry: SettlementRequest;
  family: Family;
  /** Held back from batches by an operator, whatever its status says. */
  deferred: boolean;
  requestId: string;
  quoteId: string;
  trader: string;
  arrivalSequence: number | null;
  offered: string;
  minimum: string;
  stage: Stage;
  label: string;
  tone: Tone;
  error: string | null;
  allocationCids: readonly string[];
  submittedAt: string | null;
  settlementDeadline: string;
}

/** Exact, so a meaningful minimum never rounds to zero. LP ids are long; the detail names them in full. */
export function amount(value: string, instrument: { id: string } | 'LP'): string {
  return `${formatExact(value)} ${instrument === 'LP' ? 'LP' : instrument.id}`;
}

export function rowOf(entry: SettlementRequest): QueueRow {
  if (entry.type === 'swap') {
    const swap = entry.request;
    return {
      entry,
      family: entry.type,
      deferred: entry.deferred,
      requestId: swap.swapId,
      quoteId: swap.quoteId,
      trader: swap.trader,
      arrivalSequence: swap.arrivalSequence,
      offered: amount(swap.amountIn, swap.inputInstrument),
      minimum: amount(swap.minOut, swap.outputInstrument),
      stage: STAGES[swap.status] ?? 'other',
      label: swapStatusLabels[swap.status],
      tone: swapStatusTones[swap.status],
      error: swap.error,
      allocationCids: swap.allocationCids,
      submittedAt: swap.submittedAt,
      settlementDeadline: swap.settlementDeadline,
    };
  }
  const { request } = entry;
  const shared = {
    entry,
    family: entry.type,
    deferred: entry.deferred,
    requestId: request.requestId,
    quoteId: request.quoteId,
    trader: request.terms.trader,
    arrivalSequence: request.arrivalSequence,
    stage: STAGES[request.status] ?? 'other',
    label: liquidityStatusLabels[request.status],
    tone: liquidityStatusTones[request.status],
    error: request.error,
    allocationCids: request.allocationCids,
    submittedAt: request.submittedAt,
    settlementDeadline: request.terms.settlementDeadline,
  };
  if (entry.type === 'deposit') {
    const terms = entry.request.terms;
    return {
      ...shared,
      offered: `${amount(terms.maxBaseAmount, terms.baseInstrument)} + ${amount(terms.maxQuoteAmount, terms.quoteInstrument)}`,
      minimum: amount(terms.minLpOut, 'LP'),
    };
  }
  const terms = entry.request.terms;
  return {
    ...shared,
    offered: amount(terms.lpAmount, 'LP'),
    minimum: `${amount(terms.minBaseOut, terms.baseInstrument)} + ${amount(terms.minQuoteOut, terms.quoteInstrument)}`,
  };
}

/** Arrival order within one family; a request not yet queued sorts last. */
export function byArrival(a: QueueRow, b: QueueRow): number {
  return (a.arrivalSequence ?? Infinity) - (b.arrivalSequence ?? Infinity);
}

export function sameRequest(row: QueueRow, ref: SettlementRequestRef | null | undefined): boolean {
  return ref !== null && ref !== undefined && row.family === ref.type && row.requestId === ref.requestId;
}

/**
 * One family's queue at a glance. A deferred request counts as deferred and
 * nowhere else, because no batch takes it until it returns.
 */
export interface FamilySummary {
  outstanding: number;
  ready: number;
  attention: number;
  deferred: number;
  inFlight: number;
  nearestDeadline: string | null;
}

/** ISO instants from one venue compare correctly as parsed times, not as text. */
function earliest(values: (string | null)[]): string | null {
  return values.reduce<string | null>((best, value) => {
    if (value === null) return best;
    return best === null || Date.parse(value) < Date.parse(best) ? value : best;
  }, null);
}

export function summarize(rows: readonly QueueRow[]): FamilySummary {
  const queued = rows.filter((row) => !row.deferred);
  return {
    outstanding: rows.length,
    ready: queued.filter((row) => row.stage === 'ready').length,
    attention: queued.filter(needsAttention).length,
    deferred: rows.length - queued.length,
    inFlight: queued.filter((row) => row.stage === 'inFlight').length,
    nearestDeadline: earliest(rows.map((row) => row.settlementDeadline)),
  };
}

/**
 * Past its deadline, whatever status the last read carried. The venue will
 * neither settle such a request nor return it to its queue.
 */
export function isExpired(row: QueueRow, now: number): boolean {
  return row.entry.request.status === 'EXPIRED' || deadlineUrgency(row.settlementDeadline, now) === 'passed';
}

/**
 * Whether the venue accepts a hold, or a return, for this request: ready or
 * blocked, and not expired. It also refuses both while the pool has a batch in
 * flight, and it decides.
 */
export function canChangeHold(row: QueueRow, now: number): boolean {
  return (row.stage === 'ready' || row.stage === 'blocked') && !isExpired(row, now);
}

/** A hold is a scheduling choice, not a status, so it has words of its own. */
export const holdLabels = {
  deferred: 'Deferred',
  defer: 'Defer',
  back: 'Return to queue',
} as const;

/**
 * One family's queue as a token that changes whenever anything a batch could
 * be selected from does: a request arriving, leaving, moving, or being held.
 */
export function queueToken(rows: readonly QueueRow[]): string {
  return rows
    .map((row) => `${row.requestId}:${row.entry.request.status}:${row.deferred}:${row.arrivalSequence}`)
    .join('|');
}

export type View = 'all' | 'attention' | 'ready' | 'inFlight';

export const VIEWS: { id: View; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'attention', label: 'Needs attention' },
  { id: 'ready', label: 'Ready' },
  { id: 'inFlight', label: 'In flight' },
];

/** In flight, but with an outcome the venue is still reconciling. */
const UNRESOLVED = new Set(['UNRESOLVED', 'WITHDRAWAL_UNRESOLVED', 'RECOVERY_UNRESOLVED']);

/** Blocked, unreconciled or carrying a venue error: what an operator should look at. */
function needsAttention(row: QueueRow): boolean {
  return row.stage === 'blocked' || row.error !== null || UNRESOLVED.has(row.entry.request.status);
}

function inView(row: QueueRow, view: View): boolean {
  if (view === 'all') return true;
  if (view === 'attention') return needsAttention(row);
  return row.stage === view;
}

/** Matches any identifier an operator might paste: request, quote, trader or allocation. */
function matchesSearch(row: QueueRow, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (needle === '') return true;
  return [row.requestId, row.quoteId, row.trader, ...row.allocationCids].some((value) =>
    value.toLowerCase().includes(needle),
  );
}

export function visible(row: QueueRow, view: View, search: string): boolean {
  return inView(row, view) && matchesSearch(row, search);
}

/** Two minutes: close enough to a deadline that it should stand out. */
const DEADLINE_SOON_MS = 120_000;

export const DEADLINE_ELAPSED = 'A deadline has elapsed';

export function deadlineUrgency(deadline: string, now: number): 'passed' | 'soon' | null {
  const remaining = Date.parse(deadline) - now;
  if (!Number.isFinite(remaining)) return null;
  if (remaining <= 0) return 'passed';
  return remaining <= DEADLINE_SOON_MS ? 'soon' : null;
}
