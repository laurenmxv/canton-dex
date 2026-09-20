import type { Send } from '../../../core/http.js';
import { getSettlement, listSettlements } from './history.js';
import { getSettlementMonitoring } from './monitoring.js';
import { getSettlementPolicy, updateSettlementPolicy } from './policy.js';
import { listSettlementRequests } from './queue.js';
import { runSettlement } from './run.js';
import type { SettlementsApi } from './types.js';

export function createSettlementsApi(send: Send): SettlementsApi {
  return {
    requests: (poolId, status, options) => listSettlementRequests(send, poolId, status, options),
    list: (poolId, options) => listSettlements(send, poolId, options),
    get: (settlementId, options) => getSettlement(send, settlementId, options),
    run: (poolId, input, options) => runSettlement(send, poolId, input, options),
    policy: (poolId, options) => getSettlementPolicy(send, poolId, options),
    updatePolicy: (poolId, input, options) => updateSettlementPolicy(send, poolId, input, options),
    monitoring: (poolId, options) => getSettlementMonitoring(send, poolId, options),
  };
}

export type { SettlementsApi } from './types.js';
