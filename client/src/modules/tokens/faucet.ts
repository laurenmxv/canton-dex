import type { Send } from '../../core/http.js';
import type { RequestOptions } from '../../types/common.js';
import type { FaucetPreparation, FaucetResult } from '../../types/token.js';
import type { SubmitSignatureInput } from '../../types/swap.js';

/**
 * The development faucet, which grants one fixed bundle of simulated tokens per
 * account. These routes exist only where the venue enables development tokens,
 * and answer 404 everywhere else.
 */

/** Where the caller's single claim stands. Safe to read at any time. */
export async function getFaucetStatus(
  send: Send,
  options?: RequestOptions,
): Promise<FaucetResult> {
  return send<FaucetResult>({ method: 'GET', path: '/v1/dev/faucet' }, options);
}

/**
 * Builds the claim transaction and says exactly what it grants.
 *
 * An account that already claimed is refused here rather than being given a
 * second bundle, and an unexpired preparation is handed back unchanged.
 */
export async function prepareFaucetClaim(
  send: Send,
  options?: RequestOptions,
): Promise<FaucetPreparation> {
  return send<FaucetPreparation>({ method: 'POST', path: '/v1/dev/faucet/prepare' }, options);
}

/** Submits the signed claim. The answer says where it got to, not that it landed. */
export async function submitFaucetClaim(
  send: Send,
  input: SubmitSignatureInput,
  options?: RequestOptions,
): Promise<FaucetResult> {
  return send<FaucetResult>(
    { method: 'POST', path: '/v1/dev/faucet/submit', body: input },
    options,
  );
}
