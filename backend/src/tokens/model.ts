import type { PartyPreparation } from '../onboarding/model.js';
import { InvalidRequest } from '../platform/errors.js';
import { onlyWhitespace, object, present, strictBase64, text } from '../platform/request.js';
import { epochNanos } from '../platform/time.js';

/** An instrument: its administrator and that administrator's own identifier for it. */
export interface Instrument {
  readonly admin: string;
  readonly id: string;
}

/**
 * An instrument the venue registers. The administrator and its identifier name it together: two
 * administrators may register the same symbol, and the same identifier under it.
 */
export interface RegisteredInstrument {
  readonly admin: string;
  readonly id: string;
  readonly symbol: string;
  readonly decimals: number;
}

/** An instrument in JSON that a store wrote. */
export function storedInstrument(value: unknown): Instrument {
  const fields = present(object(value), 'instrument');
  return { admin: present(text(fields.admin), 'instrument admin'), id: present(text(fields.id), 'instrument id') };
}

/** Every registered instrument, for the modules that read against the whole set. */
export interface InstrumentCatalog {
  instruments(): Promise<readonly RegisteredInstrument[]>;
}

export interface Amount {
  readonly instrument: Instrument;
  readonly symbol: string;
  readonly decimals: number;
  readonly amount: string;
}

export interface Balance {
  readonly instrument: Instrument;
  readonly symbol: string;
  readonly decimals: number;
  readonly available: string;
  readonly locked: string;
  readonly total: string;
}

/** GET /v1/balances: every balance from one read, at the ledger offset it was taken at. */
export interface Balances {
  readonly balances: readonly Balance[];
  readonly asOfOffset: bigint;
}

/** The test-token issuer's registry and faucet that the bootstrap configured. */
export interface Registry {
  readonly issuerPartyId: string;
  readonly rulesId: string;
  readonly packageId: string;
  readonly faucetFactoryId: string;
  readonly rulesCreatedEventBlob: string;
  readonly synchronizerId: string;
}

/** One instrument of the development claim bundle. */
export interface TestToken {
  readonly symbol: string;
  readonly instrumentId: string;
  readonly decimals: number;
  readonly initialClaimAmount: string;
}

/** An onboarded trader: its Ledger API user and confirmed external party. */
export interface Signer {
  readonly userId: string;
  readonly party: PartyPreparation;
}

export const FAUCET_STATUSES = ['AVAILABLE', 'PREPARED', 'SUBMITTING', 'UNRESOLVED', 'COMPLETED'] as const;
export const GRANT_STATUSES = ['PENDING', 'SUBMITTING', 'UNRESOLVED', 'CONFIRMED'] as const;
export type FaucetStatus = (typeof FAUCET_STATUSES)[number];
export type GrantStatus = (typeof GRANT_STATUSES)[number];

export interface FaucetResult {
  readonly status: FaucetStatus;
  readonly updateId: string | null;
  readonly errorCode: string | null;
  readonly error: string | null;
}

/** The claim the wallet signs, and the exact amounts it grants. */
export interface Preparation {
  readonly preparationId: string;
  readonly preparedTransactionHash: string;
  readonly hashEncoding: string;
  readonly hashingSchemeVersion: number;
  readonly partyId: string;
  readonly publicKeyFingerprint: string;
  readonly expiresAt: string;
  readonly amounts: readonly Amount[];
}

export interface Submission {
  readonly preparationId: string;
  readonly signature: string;
}

/** The participant's preparation of a claim; only the backend keeps its transaction bytes. */
export interface Prepared {
  readonly preparedTransaction: string;
  readonly preparedTransactionHash: string;
  readonly hashingSchemeVersion: number;
  readonly expiresAt: string;
}

export interface Confirmation {
  readonly contractId: string;
  readonly updateId: string;
}

/**
 * An account's one development claim. The grant is the operator's command that offers the bundle;
 * the claim is the trader's signed transaction that mints it.
 */
export interface Claim {
  readonly accountId: string;
  readonly grantId: string;
  readonly grantCommandId: string;
  readonly grantCid: string | null;
  readonly grantBeginOffset: bigint | null;
  readonly grantStatus: GrantStatus;
  readonly preparationId: string | null;
  readonly prepared: Prepared | null;
  readonly claimBeginOffset: bigint | null;
  readonly status: FaucetStatus;
  readonly updateId: string | null;
  readonly errorCode: string | null;
  readonly error: string | null;
}

/** Every venue preparation encodes its hash in Base64. */
export const HASH_ENCODING = 'base64';
/** A prepared transaction hash is a SHA-256 digest. */
export const HASH_BYTES = 32;
/** DER ECDSA and raw Ed25519 signatures, with room for longer encodings. */
const MIN_SIGNATURE_BYTES = 32;
const MAX_SIGNATURE_BYTES = 144;

/** The fields of a participant preparation that a wallet signs. */
export interface WalletPreparation {
  readonly preparedTransaction: string;
  readonly preparedTransactionHash: string;
  readonly partyId: string;
  readonly publicKeyFingerprint: string;
  readonly expiresAt: string;
}

/** A preparation that `party` can still sign; anything else is a participant or venue defect. */
export function requireSignable(signing: WalletPreparation, party: string, now: bigint): void {
  const hash = strictBase64(signing.preparedTransactionHash);
  if (!hash) throw new InvalidRequest('Invalid prepared transaction hash');
  if (
    party !== signing.partyId ||
    onlyWhitespace(signing.preparedTransaction) ||
    onlyWhitespace(signing.publicKeyFingerprint) ||
    hash.length !== HASH_BYTES ||
    epochNanos(signing.expiresAt) <= now
  ) {
    throw new Error('Invalid prepared transaction');
  }
}

/** A wallet signature in strict Base64 with a possible length; the participant verifies it. */
export function requireSignatureEncoding(signature: string): void {
  const bytes = strictBase64(signature);
  if (!bytes) throw new InvalidRequest('Invalid signature encoding');
  if (bytes.length < MIN_SIGNATURE_BYTES || bytes.length > MAX_SIGNATURE_BYTES) {
    throw new InvalidRequest('Invalid signature length');
  }
}

/** The public status; a grant in flight shows as the claim's own submission states. */
export function claimResult(claim: Claim): FaucetResult {
  const status =
    claim.grantStatus === 'SUBMITTING'
      ? 'SUBMITTING'
      : claim.grantStatus === 'UNRESOLVED'
        ? 'UNRESOLVED'
        : claim.status;
  return { status, updateId: claim.updateId, errorCode: claim.errorCode, error: claim.error };
}

export function submittingAt(claim: Claim, offset: bigint): Claim {
  return { ...claim, claimBeginOffset: offset, status: 'SUBMITTING', updateId: null, errorCode: null, error: null };
}

export function claimPreparation(claim: Claim, signer: Signer, amounts: readonly Amount[]): Preparation {
  if (claim.preparationId === null || claim.prepared === null) throw new Error('A prepared claim has no preparation');
  return {
    preparationId: claim.preparationId,
    preparedTransactionHash: claim.prepared.preparedTransactionHash,
    hashEncoding: HASH_ENCODING,
    hashingSchemeVersion: claim.prepared.hashingSchemeVersion,
    partyId: signer.party.partyId,
    publicKeyFingerprint: signer.party.publicKeyFingerprint,
    expiresAt: claim.prepared.expiresAt,
    amounts,
  };
}

export function tokenAmount(token: TestToken, issuer: string): Amount {
  return {
    instrument: { admin: issuer, id: token.instrumentId },
    symbol: token.symbol,
    decimals: token.decimals,
    amount: token.initialClaimAmount,
  };
}
