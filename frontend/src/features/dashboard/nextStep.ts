import type { Onboarding } from '../../lib/api/types';
import { RECONCILING_DETAIL } from '../onboarding/progress';

/** Where the action on the dashboard sends the trader. */
export type NextStepTarget = 'onboarding' | 'swap';

export interface NextStep {
  headline: string;
  detail: string;
  /** True only when the step is the trader's main business, not a wait. */
  primary: boolean;
  action: { label: string; target: NextStepTarget } | null;
}

/** Says nothing about a count it does not have. */
function poolSentence(eligiblePools: number | undefined): string {
  if (eligiblePools === undefined) return 'Your approved pools are open to you.';
  return eligiblePools === 1 ? 'One pool is open to you.' : `${eligiblePools} pools are open to you.`;
}

/**
 * The one thing the trader can do next, read from the onboarding the venue
 * reports. Nothing here is derived from a balance or a settlement.
 */
export function nextStep(
  onboarding: Onboarding | null,
  /** Undefined while the pool list is unknown, so no count is stated. */
  eligiblePools: number | undefined,
  /** True only where a swap screen exists to send the trader to. */
  canSwap = false,
): NextStep {
  if (!onboarding) {
    return {
      headline: 'Start your onboarding',
      detail: 'The venue reviews your application before it grants access to any pool.',
      primary: false,
      action: { label: 'Start onboarding', target: 'onboarding' },
    };
  }

  switch (onboarding.status) {
    case 'REJECTED':
      return {
        headline: 'Your application was rejected',
        detail: 'The venue operator granted no pool access. Trading stays closed.',
        primary: false,
        action: { label: 'View onboarding', target: 'onboarding' },
      };

    case 'AWAITING_REVIEW_AND_PARTY':
    case 'AWAITING_REVIEW':
      return {
        headline: 'Waiting for the venue operator',
        detail: 'Your application is under review. Nothing is left for you to do until it lands.',
        primary: false,
        action: { label: 'View onboarding', target: 'onboarding' },
      };

    case 'AWAITING_PARTY':
      return {
        headline: 'Register your party',
        detail: 'Your application is approved. Sign the preparation to register your own party.',
        primary: true,
        action: { label: 'Register party', target: 'onboarding' },
      };

    case 'PARTY_SUBMITTING':
      return {
        headline: 'Registering your party',
        detail: 'The venue is submitting your signature to the network.',
        primary: false,
        action: { label: 'View progress', target: 'onboarding' },
      };

    case 'PARTY_UNRESOLVED':
      return {
        headline: 'Confirming your party registration',
        detail: RECONCILING_DETAIL,
        primary: false,
        action: { label: 'View progress', target: 'onboarding' },
      };

    case 'LEDGER_PENDING':
    case 'LEDGER_SUBMITTING':
      return {
        headline: 'Finishing on the ledger',
        detail: 'The attestation and pool access contracts are being confirmed.',
        primary: false,
        action: { label: 'View progress', target: 'onboarding' },
      };

    case 'LEDGER_UNRESOLVED':
      return {
        headline: 'Confirming a ledger command',
        detail: RECONCILING_DETAIL,
        primary: false,
        action: { label: 'View progress', target: 'onboarding' },
      };

    case 'COMPLETED':
      return {
        // Only the demo has trading to offer, so only it says so.
        headline: canSwap ? 'You can trade' : 'Onboarding complete',
        detail: poolSentence(eligiblePools),
        primary: true,
        action: canSwap
          ? { label: 'Request swap', target: 'swap' }
          : { label: 'View onboarding', target: 'onboarding' },
      };
  }
}
