import type { RequestType } from '../../../types/activity.js';
import type { RequestOptions } from '../../../types/common.js';
import type {
  RunSettlementInput,
  Settlement,
  SettlementHistory,
  SettlementHistoryQuery,
  SettlementMonitoring,
  SettlementPolicy,
  SettlementPreview,
  SettlementQueueFilter,
  SettlementRequest,
  SettlementRequestRef,
  UpdateSettlementPolicy,
} from '../../../types/settlement.js';

/**
 * How an operator runs one pool's queues.
 *
 * Every operation names a pool. There is no venue-wide batch target, no
 * venue-wide automatic switch and no call here that touches more than the pool
 * it is given. Settings name one queue of that pool as well: the swap, deposit
 * and withdrawal queues each keep their own.
 */
export interface SettlementsApi {
  requests(
    poolId: string,
    status?: SettlementQueueFilter,
    options?: RequestOptions,
  ): Promise<SettlementRequest[]>;
  setDeferred(
    poolId: string,
    request: SettlementRequestRef,
    deferred: boolean,
    options?: RequestOptions,
  ): Promise<void>;
  preview(
    poolId: string,
    type: RequestType,
    retryOf?: string,
    options?: RequestOptions,
  ): Promise<SettlementPreview>;
  previewRequest(
    poolId: string,
    request: SettlementRequestRef,
    options?: RequestOptions,
  ): Promise<SettlementPreview>;
  list(poolId?: string, options?: RequestOptions): Promise<Settlement[]>;
  history(
    poolId: string,
    query?: SettlementHistoryQuery,
    options?: RequestOptions,
  ): Promise<SettlementHistory>;
  get(settlementId: string, options?: RequestOptions): Promise<Settlement>;
  run(poolId: string, input: RunSettlementInput, options?: RequestOptions): Promise<Settlement>;
  policy(poolId: string, type: RequestType, options?: RequestOptions): Promise<SettlementPolicy>;
  updatePolicy(
    poolId: string,
    type: RequestType,
    input: UpdateSettlementPolicy,
    options?: RequestOptions,
  ): Promise<SettlementPolicy>;
  monitoring(poolId: string, options?: RequestOptions): Promise<SettlementMonitoring>;
}
