/**
 * The backend names onboarding ledger steps `attestation` and `access:<poolId>`.
 * Build and read those keys only through here, so the format lives in one place.
 */
export const ATTESTATION_STEP = 'attestation';

const ACCESS_PREFIX = 'access:';

export function accessStep(poolId: string): string {
  return `${ACCESS_PREFIX}${poolId}`;
}

/** The pool a step grants access to, or null for any other step. */
export function accessStepPoolId(key: string): string | null {
  return key.startsWith(ACCESS_PREFIX) ? key.slice(ACCESS_PREFIX.length) : null;
}
