import type { Send } from '../../../core/http.js';
import { getSettlement, listSettlements, settlementHistory } from './history.js';
import { getSettlementMonitoring } from './monitoring.js';
import { getSettlementPolicy, updateSettlementPolicy } from './policy.js';
import { previewSettlement, previewSettlementRequest } from './preview.js';
import { listSettlementRequests, setSettlementRequestDeferred } from './queue.js';
import { runSettlement } from './run.js';
import type { SettlementsApi } from './types.js';

export function createSettlementsApi(send: Send): SettlementsApi {
  return {
    requests: (poolId, status, options) => listSettlementRequests(send, poolId, status, options),
    setDeferred: (poolId, request, deferred, options) =>
      setSettlementRequestDeferred(send, poolId, request, deferred, options),
    preview: (poolId, type, retryOf, options) =>
      previewSettlement(send, poolId, type, retryOf, options),
    previewRequest: (poolId, request, options) =>
      previewSettlementRequest(send, poolId, request, options),
    list: (poolId, options) => listSettlements(send, poolId, options),
    history: (poolId, query, options) => settlementHistory(send, poolId, query, options),
    get: (settlementId, options) => getSettlement(send, settlementId, options),
    run: (poolId, input, options) => runSettlement(send, poolId, input, options),
    policy: (poolId, type, options) => getSettlementPolicy(send, poolId, type, options),
    updatePolicy: (poolId, type, input, options) =>
      updateSettlementPolicy(send, poolId, type, input, options),
    monitoring: (poolId, options) => getSettlementMonitoring(send, poolId, options),
  };
}

export type { SettlementsApi } from './types.js';
