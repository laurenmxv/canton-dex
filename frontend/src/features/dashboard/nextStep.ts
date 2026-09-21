import type { Onboarding } from '../../lib/api/types';

/** Where the action on the dashboard sends the trader. */
export type NextStepTarget = 'onboarding' | 'swap';

export interface NextStep {
  headline: string;
  /** A count worth knowing before acting. Null where there is none. */
  detail: string | null;
  /** True only when the step is the trader's main business, not a wait. */
  primary: boolean;
  action: { label: string; target: NextStepTarget } | null;
}

/** Says nothing about a count it does not have. */
function poolCount(eligiblePools: number | undefined): string | null {
  if (eligiblePools === undefined) return null;
  return eligiblePools === 1 ? '1 pool open' : `${eligiblePools} pools open`;
}

/**
 * The one thing the trader can do next, read from the onboarding the venue
 * reports. Nothing here is derived from a balance or a settlement.
 */
export function nextStep(
  onboarding: Onboarding | null,
  /** Undefined while the pool list is unknown, so no count is stated. */
  eligiblePools: number | undefined,
): NextStep {
  if (!onboarding) {
    return {
      headline: 'Start your onboarding',
      detail: null,
      // Applying is the trader's own act, like registering a party. Only a
      // wait on someone else is offered quietly.
      primary: true,
      action: { label: 'Start onboarding', target: 'onboarding' },
    };
  }

  switch (onboarding.status) {
    case 'REJECTED':
      return {
        headline: 'Your application was rejected',
        detail: null,
        primary: false,
        action: { label: 'View onboarding', target: 'onboarding' },
      };

    case 'AWAITING_REVIEW_AND_PARTY':
    case 'AWAITING_REVIEW':
      return {
        headline: 'Waiting for the venue operator',
        detail: null,
        primary: false,
        action: { label: 'View onboarding', target: 'onboarding' },
      };

    case 'AWAITING_PARTY':
      return {
        headline: 'Register your party',
        detail: null,
        primary: true,
        action: { label: 'Register party', target: 'onboarding' },
      };

    case 'PARTY_SUBMITTING':
      return {
        headline: 'Registering your party',
        detail: null,
        primary: false,
        action: { label: 'View progress', target: 'onboarding' },
      };

    case 'PARTY_UNRESOLVED':
      return {
        headline: 'Confirming your party registration',
        detail: null,
        primary: false,
        action: { label: 'View progress', target: 'onboarding' },
      };

    case 'PARTY_CONFLICT':
      return {
        headline: 'Party registration stopped',
        detail: 'This party already exists',
        primary: false,
        action: { label: 'View onboarding', target: 'onboarding' },
      };

    case 'LEDGER_PENDING':
    case 'LEDGER_SUBMITTING':
      return {
        headline: 'Finishing on the ledger',
        detail: null,
        primary: false,
        action: { label: 'View progress', target: 'onboarding' },
      };

    case 'LEDGER_UNRESOLVED':
      return {
        headline: 'Confirming a ledger command',
        detail: null,
        primary: false,
        action: { label: 'View progress', target: 'onboarding' },
      };

    case 'COMPLETED':
      return {
        headline: 'You can trade',
        detail: poolCount(eligiblePools),
        primary: true,
        action: { label: 'Request swap', target: 'swap' },
      };
  }
}
