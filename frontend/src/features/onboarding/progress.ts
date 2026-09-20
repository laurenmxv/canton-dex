import { accessStepPoolId, ATTESTATION_STEP } from '../../lib/api/ledger-steps';
import type { LedgerStep, Onboarding, OnboardingStatus } from '../../lib/api/types';

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
 * The pools the trader may actually trade.
 *
 * Only a confirmed access contract counts. A pool being in the venue's
 * catalogue, or named in a review, says nothing about whether the ledger has
 * granted anything yet.
 */
export function confirmedPoolIds(onboarding: Onboarding | null | undefined): string[] {
  if (!onboarding) return [];
  return onboarding.ledgerSteps
    .filter((step) => step.status === 'CONFIRMED')
    .map((step) => accessStepPoolId(step.key))
    .filter((poolId): poolId is string => poolId !== null);
}

/** The attestation step once the ledger has confirmed it, and null before. */
export function confirmedAttestation(
  onboarding: Onboarding | null | undefined,
): LedgerStep | null {
  const step = onboarding?.ledgerSteps.find((candidate) => candidate.key === ATTESTATION_STEP);
  return step?.status === 'CONFIRMED' ? step : null;
}
