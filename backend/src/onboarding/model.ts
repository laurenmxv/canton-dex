import { Type, type StaticDecode } from 'typebox';
import { long, present } from '../platform/request.js';
import {
  storedBool,
  storedEnum,
  storedList,
  storedNullableText,
  storedObject,
  storedText,
} from '../platform/stored.js';
import { Conflict, InvalidRequest } from '../platform/errors.js';

export const DOCUMENT_CATEGORIES = ['IDENTITY', 'ADDRESS', 'OTHER'] as const;
export const DECISIONS = ['APPROVED', 'REJECTED'] as const;
export const EXTERNAL_MODE = 'external';
export const ATTESTATION_STEP = 'attestation';
export const ACCESS_STEP_PREFIX = 'access:';

export type Decision = (typeof DECISIONS)[number];
export const PARTY_STATUSES = ['PREPARED', 'SUBMITTING', 'CONFIRMED', 'UNRESOLVED', 'CONFLICT'] as const;
export type PartyStatus = (typeof PARTY_STATUSES)[number];
export const STEP_STATUSES = ['PENDING', 'SUBMITTING', 'CONFIRMED', 'UNRESOLVED'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const OnboardingDocument = storedObject({
  id: storedText,
  category: storedEnum(DOCUMENT_CATEGORIES),
  fileName: storedText,
  mediaType: storedText,
  sizeBytes: Type.Decode(Type.Unknown(), (value) => Number(present(long(value), 'sizeBytes'))),
  simulated: storedBool,
});
export type OnboardingDocument = StaticDecode<typeof OnboardingDocument>;

export const OnboardingApplication = storedObject({
  legalName: storedText,
  countryCode: storedText,
  documentReferences: storedList(storedText, []),
  documents: storedList(OnboardingDocument, []),
});
export type OnboardingApplication = StaticDecode<typeof OnboardingApplication>;

export interface ReviewDecision {
  readonly decision: Decision;
  readonly approvedPoolIds: readonly string[];
  readonly partyHint: string | null;
}

export interface Review {
  readonly decision: Decision;
  readonly approvedPoolIds: readonly string[];
  readonly reviewedBy: string;
  readonly reviewedAt: string;
  readonly partyHint: string | null;
}

export interface PartyPreparation {
  readonly preparationId: string;
  readonly partyId: string;
  readonly confirmed: boolean;
  readonly publicKey: string;
  readonly publicKeyFingerprint: string;
  readonly multiHash: string;
  readonly synchronizerId: string;
  readonly status: PartyStatus;
  readonly participantId: string;
  readonly topologyTransactions: readonly string[];
}

export const LedgerStep = storedObject({
  key: storedText,
  commandId: storedText,
  status: storedEnum(STEP_STATUSES),
  contractId: storedNullableText,
  updateId: storedNullableText,
  issuer: storedNullableText,
});
export type LedgerStep = StaticDecode<typeof LedgerStep>;

/** The public onboarding record; the field order is the JSON order of the API. */
export interface Onboarding {
  readonly id: string;
  readonly accountId: string;
  readonly application: OnboardingApplication;
  readonly status: string;
  readonly partyMode: string;
  readonly createdAt: string;
  readonly review: Review | null;
  readonly party: PartyPreparation | null;
  readonly ledgerSteps: readonly LedgerStep[];
  readonly suggestedPartyHint: string;
}

export interface PoolSummary {
  readonly poolId: string;
  readonly name: string;
}

/** The ledger evidence of a confirmed onboarding command. */
export interface Confirmation {
  readonly contractId: string;
  readonly updateId: string;
  readonly issuer: string;
}

/** A definitive registration conflict, not an uncertain submission to reconcile. */
export class PartyAlreadyExists extends Conflict {
  constructor() {
    super('This party already exists. Registration was stopped.', 'PARTY_ALREADY_EXISTS');
  }
}

const PARTY_HINT = /^dex_[a-z0-9][a-z0-9_]{0,59}$/;
const MAX_HINT_LENGTH = 64;

export function validatePartyHint(hint: string | null): void {
  if (hint === null || !PARTY_HINT.test(hint)) {
    throw new InvalidRequest(
      'Party hint must start with dex_ and contain a name using lowercase letters, digits and underscores (64 characters maximum)',
    );
  }
}

export function validateReview({ decision, approvedPoolIds, partyHint }: ReviewDecision): void {
  if (decision === 'APPROVED') {
    if (approvedPoolIds.length === 0) throw new InvalidRequest('Approval requires pools and a valid partyHint');
    validatePartyHint(partyHint);
  } else if (approvedPoolIds.length > 0 || partyHint !== null) {
    throw new InvalidRequest('Rejection cannot include pools or a partyHint');
  }
}

/** An ASCII party hint suggested from the legal name, within the approved hint syntax. */
export function suggestHint(name: string): string {
  const hint = name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `dex_${hint || 'trader'}`.slice(0, MAX_HINT_LENGTH);
}

/** The public status, derived from review, party registration and ledger progress. */
export function onboardingStatus(
  review: Review | null,
  party: PartyPreparation | null,
  steps: readonly LedgerStep[],
): string {
  if (review?.decision === 'REJECTED') return 'REJECTED';
  const bound = party?.confirmed === true;
  if (review === null) return bound ? 'AWAITING_REVIEW' : 'AWAITING_REVIEW_AND_PARTY';
  if (!bound) {
    switch (party?.status) {
      case 'SUBMITTING':
        return 'PARTY_SUBMITTING';
      case 'UNRESOLVED':
        return 'PARTY_UNRESOLVED';
      case 'CONFLICT':
        return 'PARTY_CONFLICT';
      default:
        return 'AWAITING_PARTY';
    }
  }
  if (steps.some((step) => step.status === 'UNRESOLVED')) return 'LEDGER_UNRESOLVED';
  if (steps.some((step) => step.status === 'SUBMITTING')) return 'LEDGER_SUBMITTING';
  return steps.length > 0 && steps.every((step) => step.status === 'CONFIRMED') ? 'COMPLETED' : 'LEDGER_PENDING';
}
