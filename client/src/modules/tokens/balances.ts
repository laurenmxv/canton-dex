import type { Send } from '../../core/http.js';
import type { RequestOptions } from '../../types/common.js';
import type { TokenBalances } from '../../types/token.js';

/**
 * What the caller's own party holds, read from the ledger rather than from a
 * cached figure.
 *
 * Every instrument the venue issues is listed, whether or not the caller holds
 * any: an unfunded one comes back with `"0"` available, locked and total.
 */
export async function getBalances(
  send: Send,
  options?: RequestOptions,
): Promise<TokenBalances> {
  return send<TokenBalances>({ method: 'GET', path: '/v1/balances' }, options);
}
