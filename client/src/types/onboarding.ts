/**
 * The onboarding JSON contract, as the backend serializes it.
 *
 * These are compile-time API types. They describe what the backend sends; they
 * do not validate a response at runtime, and the client does not repeat the
 * backend's own field validation.
 *
 * UUIDs, party identifiers, contract IDs and keys stay opaque strings.
 * Timestamps stay ISO-8601 strings, never `Date`.
 */

/** Derived by the backend from the review, the party binding and the ledger steps. */
export type OnboardingStatus =
  | 'AWAITING_REVIEW_AND_PARTY'
  | 'AWAITING_REVIEW'
  | 'AWAITING_PARTY'
  | 'REJECTED'
  | 'PARTY_SUBMITTING'
  | 'PARTY_UNRESOLVED'
  | 'PARTY_CONFLICT'
  | 'LEDGER_PENDING'
  | 'LEDGER_SUBMITTING'
  | 'LEDGER_UNRESOLVED'
  | 'COMPLETED';

export type LedgerStepStatus = 'PENDING' | 'SUBMITTING' | 'CONFIRMED' | 'UNRESOLVED';

/** How far the external party registration has travelled. */
export type PartyStatus = 'PREPARED' | 'SUBMITTING' | 'CONFIRMED' | 'UNRESOLVED' | 'CONFLICT';

export type ReviewDecisionValue = 'APPROVED' | 'REJECTED';

/**
 * How the account's party is held.
 *
 * `external` is a party the trader owns, registered from a key they hold and a
 * signature they produced. `participant-test` is the historical mode, where the
 * participant already held the party; the backend still reads those rows and
 * never creates new ones.
 */
export type PartyMode = 'external' | 'participant-test';

/** What a document stands for. The backend accepts no other category. */
export type DocumentCategory = 'IDENTITY' | 'ADDRESS' | 'OTHER';

/**
 * Metadata for one supporting document.
 *
 * `simulated` is always true: there is no upload route and no file bytes ever
 * leave the browser. The entry describes a document the venue would ask for.
 */
export interface OnboardingDocument {
  id: string;
  category: DocumentCategory;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  simulated: true;
}

/**
 * What an applicant sends.
 *
 * `documents` is what a new application carries. `documentReferences` is the
 * historical field, still accepted so older rows and the demo keep working.
 */
export interface OnboardingApplicationInput {
  legalName: string;
  countryCode: string;
  documents?: OnboardingDocument[];
  documentReferences?: string[];
}

/** What a stored application echoes back. Both lists are present, never null. */
export interface OnboardingApplication {
  legalName: string;
  countryCode: string;
  documents: OnboardingDocument[];
  documentReferences: string[];
}

export interface LedgerStep {
  /** `attestation`, or `access:<poolId>`. Opaque to this client. */
  key: string;
  commandId: string;
  status: LedgerStepStatus;
  /** Null until the step reaches `CONFIRMED`. */
  contractId: string | null;
  /** The ledger update that confirmed the step, once there is one. */
  updateId: string | null;
  /** The party that issued the contract, once the step confirms. */
  issuer: string | null;
}

export interface OnboardingReview {
  decision: ReviewDecisionValue;
  approvedPoolIds: string[];
  reviewedBy: string;
  reviewedAt: string;
  /** The hint the operator approved with. Null on a rejection. */
  partyHint: string | null;
}

/**
 * The external party being registered for this onboarding.
 *
 * No private key appears here or anywhere else in this client. `multiHash` is
 * what the trader's own signer signs.
 */
export interface PartyPreparation {
  preparationId: string;
  partyId: string;
  confirmed: boolean;
  /** Base64 canonical DER SPKI, Ed25519 or secp256k1. */
  publicKey: string | null;
  publicKeyFingerprint: string | null;
  /** Base64 of the original 34-byte SHA-256 multihash the signer signs. */
  multiHash: string | null;
  synchronizerId: string | null;
  status: PartyStatus;
  /** The participant that will host the party. Null on a historical row. */
  participantId: string | null;
  /**
   * The original topology transactions, base64 encoded, exactly as the venue
   * serialized them. The trader's own signer reads them to check what it is
   * about to sign; nothing here parses them. Empty on a historical row.
   */
  topologyTransactions: readonly string[];
}

export interface Onboarding {
  id: string;
  accountId: string;
  application: OnboardingApplication;
  status: OnboardingStatus;
  partyMode: PartyMode;
  createdAt: string;
  /** Null until an operator reviews the request. */
  review: OnboardingReview | null;
  /** Null until the trader prepares their party. */
  party: PartyPreparation | null;
  /** Empty until an approved review and a registered party open the ledger work. */
  ledgerSteps: LedgerStep[];
  /** The backend proposes dex_<normalized legal name>; edits must keep the dex_ prefix. */
  suggestedPartyHint: string;
}

/**
 * An operator's decision.
 *
 * An approval carries at least one real pool and a party hint; a rejection
 * carries no pools and no hint. The hint names the party, and is not the
 * party identifier the ledger ends up with.
 */
export interface ReviewDecisionInput {
  decision: ReviewDecisionValue;
  approvedPoolIds: string[];
  partyHint: string | null;
}

/**
 * The public half of the key pair the trader's own signer holds.
 *
 * The venue reads the algorithm from the key itself and accepts two: Ed25519,
 * which the offline development script produces, and secp256k1, which a wallet
 * produces. There is no field asserting which, and this client sends none.
 */
export interface PartyPreparationInput {
  /** Base64 canonical DER X.509 SubjectPublicKeyInfo. */
  publicKey: string;
}

/**
 * What the trader's signer produced for the preparation it was given.
 *
 * The signature is over the preparation's own multihash, in whichever form the
 * key's algorithm calls for: a raw 64-byte Ed25519 signature, or an ASN.1 DER
 * ECDSA signature for secp256k1. Both arrive base64.
 */
export interface PartySubmissionInput {
  preparationId: string;
  /** Base64 signature over the preparation's multihash. */
  signature: string;
}
