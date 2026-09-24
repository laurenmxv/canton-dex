/** FIFO batch selection over a pool's per-family queues. */
import type { Family } from '../platform/database.js';
import { FAMILIES, type Policy, type QueueRequest } from './model.js';

/** Requests that a batch may carry; any other status stops its family's FIFO prefix. */
export const SELECTABLE_STATUSES = new Set(['READY', 'BLOCKED']);

/** An empty pool's initialization settles on its own. */
function initializes(queued: QueueRequest): boolean {
  return queued.type === 'deposit' && 'mode' in queued.request.terms && queued.request.terms.mode === 'INITIAL';
}

function arrival(queued: QueueRequest): bigint {
  const sequence = queued.request.arrivalSequence;
  if (sequence === null) throw new Error('A queued request has no arrival sequence');
  return sequence;
}

/** Family order, then arrival order. */
export function queueOrder(left: QueueRequest, right: QueueRequest): number {
  if (left.type !== right.type) return left.type < right.type ? -1 : 1;
  const difference = arrival(left) - arrival(right);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

/**
 * The longest selectable prefix of one family's queue, up to `limit`. Deferred requests are
 * skipped; any other unselectable request stops the prefix, so later requests never jump it.
 */
export function prefix(queue: readonly QueueRequest[], limit: number): QueueRequest[] {
  const selected: QueueRequest[] = [];
  for (const queued of queue) {
    if (queued.deferred) continue;
    if (selected.length === limit || !SELECTABLE_STATUSES.has(queued.request.status)) break;
    const individual = initializes(queued);
    const [first] = selected;
    if (first && (individual || queued.type !== first.type)) break;
    selected.push(queued);
    if (individual) break;
  }
  return selected;
}

/**
 * The next batch, rotating through the families after the last one processed. Automatic runs skip
 * disabled or blocked families and wait for a full swap batch.
 */
export function select(
  requests: readonly QueueRequest[],
  policies: readonly Policy[],
  lastProcessedFamily: Family | null,
  blockedFamilies: ReadonlySet<Family>,
  automatic: boolean,
): QueueRequest[] {
  const start = lastProcessedFamily === null ? 0 : FAMILIES.indexOf(lastProcessedFamily) + 1;
  for (let step = 0; step < FAMILIES.length; step += 1) {
    const family = FAMILIES[(start + step) % FAMILIES.length];
    const policy = policies.find((candidate) => candidate.type === family);
    if (family === undefined || !policy) throw new Error('Every family has a settlement policy');
    if (blockedFamilies.has(family)) continue;
    if (automatic && (!policy.automaticEnabled || policy.batchSize > policy.maxBatchSize)) continue;
    const queue = requests.filter((queued) => queued.type === family).sort(queueOrder);
    const selected = prefix(queue, policy.batchSize);
    if (selected.length === 0) continue;
    if (automatic && family === 'swap' && selected.length < policy.batchSize) continue;
    return selected;
  }
  return [];
}
