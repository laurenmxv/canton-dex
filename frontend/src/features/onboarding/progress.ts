import { accessStepPoolId, ATTESTATION_STEP } from '../../lib/api/ledger-steps';
import {
  venueErrorCode,
  type LedgerStep,
  type Onboarding,
  type OnboardingStatus,
} from '../../lib/api/types';

/**
 * Statuses that change without the reader doing anything: the venue is working,
 * or another session is. A screen showing one keeps polling.
 */
const SETTLING = new Set<OnboardingStatus>([
  'AWAITING_REVIEW_AND_PARTY',
  'AWAITING_REVIEW',
  'AWAITING_PARTY',
  'PARTY_SUBMITTING',
  'PARTY_UNRESOLVED',
  'LEDGER_PENDING',
  'LEDGER_SUBMITTING',
  'LEDGER_UNRESOLVED',
]);

/** True while something other than this reader may still move the request. */
export function isSettling(onboarding: Onboarding | null | undefined): boolean {
  return onboarding !== null && onboarding !== undefined && SETTLING.has(onboarding.status);
}

/** Statuses the venue only leaves when a person acts, so a dot would mislead. */
export function isWorking(onboarding: Onboarding | null | undefined): boolean {
  const status = onboarding?.status;
  return (
    status === 'PARTY_SUBMITTING' || status === 'LEDGER_PENDING' || status === 'LEDGER_SUBMITTING'
  );
}

/**
 * True while a command's outcome is unknown and the venue is still looking for
 * evidence of it. It is not a failure and not a completion.
 */
export function isReconciling(onboarding: Onboarding | null | undefined): boolean {
  const status = onboarding?.status;
  return status === 'PARTY_UNRESOLVED' || status === 'LEDGER_UNRESOLVED';
}

/**
 * Pools granted during onboarding. These historical steps do not report
 * later revocations; the venue rechecks current access before each operation.
 */
export function confirmedPoolIds(onboarding: Onboarding | null | undefined): string[] {
  if (!onboarding) return [];
  return onboarding.ledgerSteps
    .filter((step) => step.status === 'CONFIRMED')
    .map((step) => accessStepPoolId(step.key))
    .filter((poolId): poolId is string => poolId !== null);
}

/** True when the venue refused an action because the trader's KYC or pool access is not current. */
export function lacksPoolAccess(error: unknown): boolean {
  return venueErrorCode(error) === 'POOL_ACCESS_REQUIRED';
}

/** The attestation step once the ledger has confirmed it, and null before. */
export function confirmedAttestation(
  onboarding: Onboarding | null | undefined,
): LedgerStep | null {
  const step = onboarding?.ledgerSteps.find((candidate) => candidate.key === ATTESTATION_STEP);
  return step?.status === 'CONFIRMED' ? step : null;
}
