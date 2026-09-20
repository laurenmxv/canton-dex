import type { InstrumentId } from './pool.js';

/**
 * What the caller holds of one instrument, at one ledger observation.
 *
 * `locked` is not gone: it is reserved by an allocation a swap request made,
 * and it comes back if that request is reclaimed. `decimals` is the precision
 * the instrument accepts, and an amount with more fractional digits than that
 * is refused by the venue.
 */
export interface TokenBalance {
  instrument: InstrumentId;
  symbol: string;
  decimals: number;
  available: string;
  locked: string;
  total: string;
}

/** Every balance from one read, with the ledger offset they were taken at. */
export interface TokenBalances {
  balances: readonly TokenBalance[];
  asOfOffset: number;
}

/** One amount of one instrument, carrying the instrument's own precision. */
export interface TokenAmount {
  instrument: InstrumentId;
  symbol: string;
  decimals: number;
  amount: string;
}

/**
 * Where the caller's one development claim stands.
 *
 * `AVAILABLE` means it has not been claimed. `COMPLETED` is final: the bundle
 * is granted once per account and never again. `UNRESOLVED` means the venue has
 * not seen the outcome yet, and is neither a failure nor a completion.
 */
export type FaucetStatus = 'AVAILABLE' | 'PREPARED' | 'SUBMITTING' | 'UNRESOLVED' | 'COMPLETED';

export interface FaucetResult {
  status: FaucetStatus;
  updateId: string | null;
  errorCode: string | null;
  error: string | null;
}

/**
 * The claim the wallet is asked to sign, and the exact amounts it grants.
 *
 * As with a swap, only the hash crosses this boundary. The wallet signs those
 * bytes unchanged and never rebuilds the transaction behind them.
 */
export interface FaucetPreparation {
  preparationId: string;
  preparedTransactionHash: string;
  /** `base64`, as every venue preparation encodes its hash today. */
  hashEncoding: string;
  hashingSchemeVersion: number;
  partyId: string;
  publicKeyFingerprint: string;
  expiresAt: string;
  amounts: readonly TokenAmount[];
}
