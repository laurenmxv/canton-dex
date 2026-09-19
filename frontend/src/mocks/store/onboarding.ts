import { accessStep, ATTESTATION_STEP } from '../../lib/api/ledger-steps';
import type {
  LedgerStep,
  Onboarding,
  OnboardingApplicationInput,
  OnboardingDocument,
  OnboardingStatus,
  PartyPreparationInput,
  PartySubmissionInput,
  PoolSummary,
  ReviewDecisionInput,
} from '../../lib/api/types';
import {
  applicationLimits,
  COUNTRY_CODE_PATTERN,
  DomainError,
  PARTY_HINT_PATTERN,
} from '../../lib/api/types';
import { seedOnboardingApplication } from '../data';
import {
  createDemoState,
  locate,
  nextId,
  now,
  requireIdentity,
  requireRole,
  type DemoState,
} from './state';

// ---------------------------------------------------------------- onboarding

/** Mirrors `OnboardingStore.status` in the Java backend, condition for condition. */
export function deriveStatus(onboarding: Onboarding): OnboardingStatus {
  const party = onboarding.party;
  const bound = party?.confirmed === true;
  const review = onboarding.review;
  if (review?.decision === 'REJECTED') return 'REJECTED';
  if (review === null) return bound ? 'AWAITING_REVIEW' : 'AWAITING_REVIEW_AND_PARTY';
  if (party?.status === 'UNRESOLVED') return 'PARTY_UNRESOLVED';
  if (party?.status === 'SUBMITTING') return 'PARTY_SUBMITTING';
  if (!bound) return 'AWAITING_PARTY';
  const steps = onboarding.ledgerSteps;
  if (steps.some((step) => step.status === 'UNRESOLVED')) return 'LEDGER_UNRESOLVED';
  if (steps.some((step) => step.status === 'SUBMITTING')) return 'LEDGER_SUBMITTING';
  if (steps.length > 0 && steps.every((step) => step.status === 'CONFIRMED')) return 'COMPLETED';
  return 'LEDGER_PENDING';
}

function refresh(state: DemoState, onboarding: Onboarding): Onboarding {
  ensureLedgerSteps(state, onboarding);
  onboarding.status = deriveStatus(onboarding);
  return onboarding;
}

/**
 * Steps appear only once both prerequisites hold, so approval-then-party and
 * party-then-approval converge on the same ledger work.
 */
function ensureLedgerSteps(state: DemoState, onboarding: Onboarding): void {
  const approved = onboarding.review?.decision === 'APPROVED';
  if (!approved || onboarding.party?.confirmed !== true) return;
  if (onboarding.ledgerSteps.length > 0) return;
  const keys = [ATTESTATION_STEP, ...onboarding.review!.approvedPoolIds.map(accessStep)];
  onboarding.ledgerSteps = keys.map<LedgerStep>((key) => ({
    key,
    commandId: nextId(state, 'cmd'),
    status: 'PENDING',
    contractId: null,
    updateId: null,
    issuer: null,
  }));
}

/**
 * Advances every outstanding step by one stage, standing in for the ledger
 * confirming the commands the venue submitted.
 */
export function tickLedger(state: DemoState, onboarding: Onboarding): void {
  for (const step of onboarding.ledgerSteps) {
    if (step.status === 'PENDING') {
      step.status = 'SUBMITTING';
    } else if (step.status === 'SUBMITTING') {
      step.status = 'CONFIRMED';
      step.contractId = `00${nextId(state, 'cid').replace(/-/g, '')}${'a3f9'.repeat(2)}`;
      step.updateId = `1220${nextId(state, 'upd').replace(/-/g, '')}`;
      step.issuer = state.venueOperatorParty;
    }
  }
}

/** Traders reach only their own onboarding; an operator's read is separate. */
export function findOwnedOnboarding(
  state: DemoState,
  accountId: string,
  onboardingId: string,
): Onboarding {
  requireRole(state, accountId, 'TRADER');
  const onboarding = locate(state, onboardingId);
  // Another account's onboarding must look exactly like one that never existed.
  if (onboarding.accountId !== accountId) {
    throw new DomainError('Onboarding not found', 'NOT_FOUND');
  }
  return refresh(state, onboarding);
}

export function findOnboardingAsOperator(
  state: DemoState,
  accountId: string,
  onboardingId: string,
): Onboarding {
  requireRole(state, accountId, 'OPERATOR');
  return refresh(state, locate(state, onboardingId));
}

export function listOnboardings(state: DemoState, accountId: string): Onboarding[] {
  requireRole(state, accountId, 'OPERATOR');
  return state.onboardings.map((onboarding) => refresh(state, onboarding));
}

export function findOnboardingForAccount(
  state: DemoState,
  accountId: string,
): Onboarding | null {
  requireRole(state, accountId, 'TRADER');
  const found = state.onboardings.find((candidate) => candidate.accountId === accountId);
  return found ? refresh(state, found) : null;
}

function requireText(value: string, label: string, maxLength: number): string {
  const trimmed = value.trim();
  if (!trimmed) throw new DomainError(`${label} is required`, 'VALIDATION');
  if (trimmed.length > maxLength) {
    throw new DomainError(`${label} is longer than ${maxLength} characters`, 'VALIDATION');
  }
  return trimmed;
}

/** The party name the venue proposes, derived from the applicant's own name. */
export function suggestPartyHint(legalName: string): string {
  const hint = legalName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return PARTY_HINT_PATTERN.test(hint) ? hint : 'trader';
}

function readDocuments(documents: OnboardingDocument[]): OnboardingDocument[] {
  return documents.map((document) => ({
    id: requireText(document.id, 'Document id', 200),
    category: document.category,
    fileName: requireText(document.fileName, 'File name', applicationLimits.fileNameMaxLength),
    mediaType: requireText(document.mediaType, 'Media type', applicationLimits.mediaTypeMaxLength),
    sizeBytes: document.sizeBytes,
    simulated: true,
  }));
}

export function submitApplication(
  state: DemoState,
  accountId: string,
  application: OnboardingApplicationInput,
): Onboarding {
  requireRole(state, accountId, 'TRADER');
  if (state.onboardings.some((candidate) => candidate.accountId === accountId)) {
    throw new DomainError('This account already has an onboarding', 'CONFLICT');
  }
  const legalName = requireText(
    application.legalName,
    'Legal name',
    applicationLimits.legalNameMaxLength,
  );
  if (!COUNTRY_CODE_PATTERN.test(application.countryCode)) {
    throw new DomainError('Country must be a two-letter ISO code', 'VALIDATION');
  }
  // Document metadata is what an application carries now; the references are
  // the historical field, kept so seeded rows keep working.
  const documentReferences = (application.documentReferences ?? []).map((reference) =>
    requireText(reference, 'Document reference', applicationLimits.documentMaxLength),
  );
  const documents =
    application.documents === undefined ? [] : readDocuments(application.documents);
  const attached = documents.length + documentReferences.length;
  if (attached < applicationLimits.documentsMin || attached > applicationLimits.documentsMax) {
    throw new DomainError(
      `Provide between ${applicationLimits.documentsMin} and ${applicationLimits.documentsMax} documents`,
      'VALIDATION',
    );
  }

  const onboarding: Onboarding = {
    id: nextId(state, 'onb'),
    accountId,
    // Copied, so a later change by the caller cannot reach demo state.
    application: {
      legalName,
      countryCode: application.countryCode,
      documents,
      documentReferences,
    },
    status: 'AWAITING_REVIEW_AND_PARTY',
    // A row built from references is one the participant would have held.
    partyMode: documents.length > 0 ? 'external' : 'participant-test',
    createdAt: now(),
    review: null,
    party: null,
    ledgerSteps: [],
    suggestedPartyHint: suggestPartyHint(legalName),
  };
  state.onboardings.push(onboarding);
  return refresh(state, onboarding);
}

/**
 * Idempotent for the same key, like the backend: the preparation survives
 * repeat calls, and a different key is refused rather than replacing it.
 */
export function prepareParty(
  state: DemoState,
  accountId: string,
  onboardingId: string,
  input: PartyPreparationInput,
): Onboarding {
  const onboarding = findOwnedOnboarding(state, accountId, onboardingId);
  if (onboarding.review?.decision !== 'APPROVED') {
    throw new DomainError('The venue has not approved this request yet', 'CONFLICT');
  }
  const publicKey = requireText(input.publicKey, 'Public key', 4096);
  const existing = onboarding.party;
  if (existing) {
    if (existing.publicKey !== publicKey) {
      throw new DomainError('A different key is already prepared for this request', 'CONFLICT');
    }
    return onboarding;
  }
  const hint = onboarding.review.partyHint ?? onboarding.suggestedPartyHint;
  const fingerprint = `1220${nextId(state, 'fpr').replace(/-/g, '')}`;
  onboarding.party = {
    preparationId: nextId(state, 'prep'),
    partyId: `${hint}::${fingerprint}`,
    confirmed: false,
    publicKey,
    publicKeyFingerprint: fingerprint,
    multiHash: `1220${nextId(state, 'hash').replace(/-/g, '')}`,
    synchronizerId: state.synchronizerId,
    status: 'PREPARED',
    participantId: state.participantId,
    // Base64 of a marker, not a Canton topology transaction. The demo cannot
    // produce one, and a signer checking this would rightly refuse it.
    topologyTransactions: [btoa(`simulated-topology:${fingerprint}`)],
  };
  return refresh(state, onboarding);
}

/**
 * A key and a signature the demo makes up for itself.
 *
 * Neither is a Canton credential, and both live here rather than in a screen,
 * so nothing above the port ever holds an invented one.
 */
const SIMULATED_PUBLIC_KEY = 'MCowBQYDK2VwAyEAZGVtby1wdWJsaWMta2V5LWJ5dGVzLWZvci1maXh0dXJl';
const SIMULATED_SIGNATURE = 'c2ltdWxhdGVkLXNpZ25hdHVyZS1mb3ItdGhpcy1wcmVwYXJhdGlvbg==';

/** What a wallet would do, in one step, for a demo that has none. */
export function simulatePartyRegistration(
  state: DemoState,
  accountId: string,
  onboardingId: string,
): Onboarding {
  const prepared = prepareParty(state, accountId, onboardingId, {
    publicKey: SIMULATED_PUBLIC_KEY,
  });
  return confirmParty(state, accountId, onboardingId, {
    preparationId: prepared.party!.preparationId,
    signature: SIMULATED_SIGNATURE,
  });
}

export function confirmParty(
  state: DemoState,
  accountId: string,
  onboardingId: string,
  input: PartySubmissionInput,
): Onboarding {
  const onboarding = findOwnedOnboarding(state, accountId, onboardingId);
  const party = onboarding.party;
  if (!party || party.preparationId !== input.preparationId) {
    throw new DomainError('Preparation does not match this onboarding', 'NOT_FOUND');
  }
  if (party.confirmed) return onboarding;
  // The demo cannot verify a real signature, so it checks only that one was
  // produced for this preparation. The real backend verifies it properly.
  if (requireText(input.signature, 'Signature', 4096).length < 16) {
    throw new DomainError('The signature is not the one this preparation needs', 'VALIDATION');
  }
  onboarding.party = { ...party, confirmed: true, status: 'CONFIRMED' };
  return refresh(state, onboarding);
}

/** The venue's catalogue: every pool that exists, by name. */
export function poolCatalogue(state: DemoState, accountId: string): PoolSummary[] {
  requireIdentity(state, accountId);
  return state.pools.map((pool) => ({ poolId: pool.poolId, name: pool.name }));
}

/** Repeating the identical decision succeeds; a conflicting one does not. */
export function reviewOnboarding(
  state: DemoState,
  accountId: string,
  onboardingId: string,
  decision: ReviewDecisionInput,
): Onboarding {
  const onboarding = findOnboardingAsOperator(state, accountId, onboardingId);
  const approving = decision.decision === 'APPROVED';
  const pools = [...new Set(decision.approvedPoolIds)].sort();
  if (approving && pools.length === 0) {
    throw new DomainError('Approval needs at least one pool', 'VALIDATION');
  }
  if (!approving && pools.length > 0) {
    throw new DomainError('Rejection cannot approve pools', 'VALIDATION');
  }
  if (pools.length > applicationLimits.approvedPoolsMax) {
    throw new DomainError(
      `Approve at most ${applicationLimits.approvedPoolsMax} pools`,
      'VALIDATION',
    );
  }
  for (const poolId of pools) {
    if (!state.pools.some((pool) => pool.poolId === poolId)) {
      throw new DomainError(`Unknown pool ${poolId}`, 'VALIDATION');
    }
  }

  const hint = decision.partyHint;
  if (approving && (hint === null || !PARTY_HINT_PATTERN.test(hint))) {
    throw new DomainError('Approval needs a party name the ledger accepts', 'VALIDATION');
  }
  if (!approving && hint !== null) {
    throw new DomainError('Rejection cannot name a party', 'VALIDATION');
  }

  const existing = onboarding.review;
  if (existing) {
    const identical =
      existing.decision === decision.decision &&
      existing.partyHint === hint &&
      existing.approvedPoolIds.length === pools.length &&
      existing.approvedPoolIds.every((poolId, index) => poolId === pools[index]);
    if (!identical) throw new DomainError('Onboarding is already reviewed', 'CONFLICT');
    return refresh(state, onboarding);
  }

  onboarding.review = {
    decision: decision.decision,
    approvedPoolIds: pools,
    reviewedBy: accountId,
    reviewedAt: now(),
    partyHint: hint,
  };
  return refresh(state, onboarding);
}


/**
 * A world with one request already waiting, so the operator queue is never
 * empty. It lives here rather than in `state.ts` because seeding goes through
 * `submitApplication`, and a module that holds the state should not depend on
 * the module that changes it.
 */
export function seededDemoState(): DemoState {
  const state = createDemoState();
  const seeded = submitApplication(state, seedOnboardingApplication.accountId, {
    legalName: seedOnboardingApplication.legalName,
    countryCode: seedOnboardingApplication.countryCode,
    documentReferences: [...seedOnboardingApplication.documentReferences],
  });
  seeded.createdAt = seedOnboardingApplication.createdAt;
  return state;
}
