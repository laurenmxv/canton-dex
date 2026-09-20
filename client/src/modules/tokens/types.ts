import type { RequestOptions } from '../../types/common.js';
import type { SubmitSignatureInput } from '../../types/swap.js';
import type { FaucetPreparation, FaucetResult, TokenBalances } from '../../types/token.js';

/**
 * The caller's own holdings, and the development faucet that seeds them.
 *
 * The faucet is a local development capability, not part of the venue's
 * product surface: a deployment without development tokens serves no such
 * route, and every faucet call there answers 404.
 */
export interface TokensApi {
  balances(options?: RequestOptions): Promise<TokenBalances>;
  faucetStatus(options?: RequestOptions): Promise<FaucetResult>;
  prepareFaucetClaim(options?: RequestOptions): Promise<FaucetPreparation>;
  submitFaucetClaim(input: SubmitSignatureInput, options?: RequestOptions): Promise<FaucetResult>;
}
