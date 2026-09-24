import type {
  SettlementOutputCheck,
  SettlementPreview,
  SettlementPreviewStep,
} from '../../lib/api/types';
import { compareDecimals, formatExact, parseDecimal } from '../../lib/decimal';
import { trimDecimal, type Tone } from '../../lib/labels';
import { DEADLINE_ELAPSED, isExpired, type QueueRow } from './queueRows';
import type { ReservePair } from './reserves';
import type { PreviewRead } from './usePreview';

/**
 * At or below this headroom over the signed minimum, a projected output shows
 * as a thin margin. It sits well under the usual quote slippage, so an output
 * near its quote reads as normal. It is a display threshold: the venue applies
 * no such rule.
 */
export const THIN_MARGIN_BPS = 10;

const THIN_MARGIN = parseDecimal(String(THIN_MARGIN_BPS))!;

/** How one step of a preview reads: its venue status, with a thin margin set apart. */
export type StepState = 'projected' | 'thin' | 'blocked' | 'unchecked';

export const stepStateLabels: Record<StepState, string> = {
  projected: 'Projected',
  thin: 'Thin margin',
  blocked: 'Blocked',
  unchecked: 'Not evaluated',
};

export const stepStateTones: Record<StepState, Tone> = {
  projected: 'progress',
  thin: 'warning',
  blocked: 'danger',
  unchecked: 'neutral',
};

/** True where the venue's headroom is at or below the display threshold. */
export function isThin(check: SettlementOutputCheck): boolean {
  if (check.headroomBps === null) return false;
  const headroom = parseDecimal(check.headroomBps);
  return headroom !== null && compareDecimals(headroom, THIN_MARGIN) <= 0;
}

export function stepStateOf(step: SettlementPreviewStep): StepState {
  if (step.status === 'BLOCKED') return 'blocked';
  if (step.status === 'NOT_EVALUATED') return 'unchecked';
  return step.outputs.some(isThin) ? 'thin' : 'projected';
}

/** The venue's headroom as written, or a dash where the amount leaves none to state. */
export function formatHeadroom(headroomBps: string | null): string {
  return headroomBps === null ? '—' : `${trimDecimal(headroomBps)} bps`;
}

/** Both reserves of one state, exact, the way the chart and its key both write them. */
export function reserveText(pair: ReservePair, baseLabel: string, quoteLabel: string): string {
  return `${formatExact(pair.baseReserve)} ${baseLabel} · ${formatExact(pair.quoteReserve)} ${quoteLabel}`;
}

/** One marker on the trajectory: the observed start, or where one step leaves the pool. */
export interface TrajectoryPoint {
  /** The step's place in the batch, from 1. Null for the observed start. */
  step: number | null;
  state: StepState | 'observed';
  reserves: ReservePair;
}

/**
 * Where each checked step leaves the pool, from the observed snapshot on.
 *
 * A valid step moves to its projected `after`. The blocked step stays where
 * the step before it left the pool, because a request that fails moves
 * nothing. Nothing checked the steps after it, so they have no place to draw.
 */
export function trajectory(preview: SettlementPreview): TrajectoryPoint[] {
  const points: TrajectoryPoint[] = [{ step: null, state: 'observed', reserves: preview.pool.reserves }];
  preview.steps.forEach((step, index) => {
    const state = stepStateOf(step);
    if (step.status === 'VALID' && step.after) points.push({ step: index + 1, state, reserves: step.after });
    if (step.status === 'BLOCKED') points.push({ step: index + 1, state, reserves: step.before });
  });
  return points;
}

export const NOTHING_TO_SETTLE = 'Nothing to settle';
export const NO_PROJECTED_MOVE = 'No projected move';
/** The state the venue observed, which every projection starts from. */
export const OBSERVED = 'Observed';

/** The queued row a step names, where the queue still lists it. */
export function rowOfStep(
  step: SettlementPreviewStep,
  rows: readonly QueueRow[] | undefined,
): QueueRow | undefined {
  return rows?.find((row) => row.requestId === step.request.requestId);
}

export interface RunConditions {
  /** The preview of the queue on screen, which is the only batch a run may send. */
  preview: PreviewRead;
  /** That queue as last read. */
  rows: readonly QueueRow[] | undefined;
  now: number;
  /** The pool has a batch in flight, as monitoring reports it. */
  inFlight: boolean;
  /** A run whose outcome the venue has not answered yet. */
  unresolved: boolean;
  /** A change this screen sent is still waiting for its answer. */
  busy: boolean;
}

/**
 * Why "Run batch" cannot run the previewed batch now, or null when it can.
 *
 * This only decides what the button offers. The venue checks the selection
 * again when it is sent, and refuses one that has gone stale.
 */
export function runBlocker({ preview: read, rows, now, inFlight, unresolved, busy }: RunConditions): string | null {
  const preview = read.data;
  const queued = (preview?.steps ?? []).map((step) => rowOfStep(step, rows));
  if (busy) return 'Waiting for the last change';
  if (unresolved) return 'The last run is unresolved';
  if (inFlight || preview?.activeSettlementId) return 'A batch is in flight';
  if (!preview) return read.loading ? 'Loading the preview' : 'Projection unavailable';
  if (read.error !== undefined && !read.loading) return 'Could not refresh the preview';
  // A step the queue no longer lists means the preview is behind the queue.
  if (read.stale || read.loading || queued.includes(undefined)) return 'Refreshing the preview';
  if (preview.steps.length === 0) return NOTHING_TO_SETTLE;
  const blocked = preview.steps.findIndex((step) => step.status === 'BLOCKED');
  if (blocked >= 0) return `Step ${blocked + 1} is blocked`;
  if (queued.some((row) => row !== undefined && isExpired(row, now))) return DEADLINE_ELAPSED;
  if (!preview.executable) return 'The venue would not start this batch';
  return null;
}
