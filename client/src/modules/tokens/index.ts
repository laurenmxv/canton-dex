import type { Send } from '../../core/http.js';
import { getBalances } from './balances.js';
import { getFaucetStatus, prepareFaucetClaim, submitFaucetClaim } from './faucet.js';
import type { TokensApi } from './types.js';

export function createTokensApi(send: Send): TokensApi {
  return {
    balances: (options) => getBalances(send, options),
    faucetStatus: (options) => getFaucetStatus(send, options),
    prepareFaucetClaim: (options) => prepareFaucetClaim(send, options),
    submitFaucetClaim: (input, options) => submitFaucetClaim(send, input, options),
  };
}

export type { TokensApi } from './types.js';
