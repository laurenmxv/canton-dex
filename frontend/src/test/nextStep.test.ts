import { describe, expect, it } from 'vitest';
import { nextStep } from '../features/dashboard/nextStep';
import type { Onboarding, OnboardingStatus } from '../lib/api/types';

function onboardingAt(status: OnboardingStatus): Onboarding {
  return {
    id: 'onb-0001',
    accountId: 'acc-trader-alice',
    application: {
      legalName: 'Acme Trading Ltd',
      countryCode: 'PT',
      documents: [],
      documentReferences: ['d'],
    },
    status,
    partyMode: 'external',
    createdAt: '2026-09-17T08:30:00Z',
    review: null,
    party: null,
    ledgerSteps: [],
    suggestedPartyHint: 'acme_trading',
  };
}

describe('the trader’s next step', () => {
  it('sends someone who has not applied to onboarding', () => {
    const step = nextStep(null, 0);
    expect(step.headline).toBe('Start your onboarding');
    expect(step.action).toEqual({ label: 'Start onboarding', target: 'onboarding' });
  });

  it('asks for nothing until the venue has approved', () => {
    for (const status of ['AWAITING_REVIEW_AND_PARTY', 'AWAITING_REVIEW'] as const) {
      const step = nextStep(onboardingAt(status), 0);
      expect(step.headline).toBe('Waiting for the venue operator');
      expect(step.primary).toBe(false);
    }
  });

  it('asks the trader to register their party once approval lands', () => {
    const step = nextStep(onboardingAt('AWAITING_PARTY'), 0);
    expect(step.headline).toBe('Register your party');
    expect(step.primary).toBe(true);
    expect(step.action).toEqual({ label: 'Register party', target: 'onboarding' });
  });

  it('reports party registration that is working, and one still being confirmed', () => {
    expect(nextStep(onboardingAt('PARTY_SUBMITTING'), 0).headline).toBe('Registering your party');
    expect(nextStep(onboardingAt('PARTY_UNRESOLVED'), 0).headline).toBe(
      'Confirming your party registration',
    );
  });

  it.each(['PARTY_UNRESOLVED', 'LEDGER_UNRESOLVED'] as const)(
    'never asks the reader to act on %s, and never promises a resubmission',
    (status) => {
      const step = nextStep(onboardingAt(status), 0);
      expect(step.primary).toBe(false);
      // It promises no outcome, in either direction.
      expect(step.headline).not.toMatch(/will (be resubmitted|retry|complete)|trying again|failed/i);
    },
  );

  it('offers no primary action while the ledger is still working', () => {
    for (const status of ['LEDGER_SUBMITTING', 'LEDGER_UNRESOLVED'] as const) {
      const step = nextStep(onboardingAt(status), 0);
      expect(step.primary).toBe(false);
      expect(step.action?.target).toBe('onboarding');
    }
  });

  it('offers a swap only once onboarding completes, and counts the open pools', () => {
    expect(nextStep(onboardingAt('COMPLETED'), 1)).toMatchObject({
      headline: 'You can trade',
      detail: '1 pool open',
      primary: true,
      action: { label: 'Request swap', target: 'swap' },
    });
    expect(nextStep(onboardingAt('COMPLETED'), 3).detail).toBe('3 pools open');
  });

  it('states no pool count while the pool list is unknown', () => {
    const step = nextStep(onboardingAt('COMPLETED'), undefined);
    expect(step.headline).toBe('You can trade');
    expect(step.detail).toBeNull();
  });

  it('offers no way to trade after a rejection', () => {
    const step = nextStep(onboardingAt('REJECTED'), 0);
    expect(step.primary).toBe(false);
    expect(step.action?.target).toBe('onboarding');
  });

  it('never promises a balance, a portfolio or a settlement', () => {
    const statuses: OnboardingStatus[] = [
      'AWAITING_REVIEW_AND_PARTY',
      'AWAITING_REVIEW',
      'AWAITING_PARTY',
      'REJECTED',
      'LEDGER_PENDING',
      'LEDGER_SUBMITTING',
      'LEDGER_UNRESOLVED',
      'COMPLETED',
    ];
    for (const status of [...statuses.map(onboardingAt), null]) {
      const { headline, detail } = nextStep(status, 1);
      expect(`${headline} ${detail ?? ''}`).not.toMatch(/balance|portfolio|yield|settled|profit/i);
    }
  });
});
