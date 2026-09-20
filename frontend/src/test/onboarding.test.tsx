import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  approveForPool,
  goTo,
  LEDGER_WAIT,
  openRow,
  registerParty,
  rejectRequest,
  submitApplication,
} from './flows';
import { renderApp } from './harness';

/**
 * Review and party confirmation are independent prerequisites. Either order
 * must reach the same completed onboarding.
 */
describe('onboarding', () => {
  it('completes when review lands before party confirmation', async () => {
    const { user, actAs } = renderApp();

    await submitApplication(user);
    expect(await screen.findByText('Awaiting review and party')).toBeInTheDocument();

    await actAs('Venue Operations');
    await openRow(user, 'Acme Trading Ltd');
    await approveForPool(user, 'USDC / EURC');
    expect(await screen.findByText('Awaiting party registration')).toBeInTheDocument();

    await actAs('Alice Carter');
    await goTo(user, 'Onboarding');
    await registerParty(user);

    expect(await screen.findByText('Completed', {}, LEDGER_WAIT)).toBeInTheDocument();
  });

  it('opens party registration only once the venue has named the party', async () => {
    const { user, actAs } = renderApp();

    await submitApplication(user);

    // Nothing to sign yet: the venue names the party when it approves.
    expect(
      screen.queryByRole('button', { name: 'Simulate registration' }),
    ).not.toBeInTheDocument();
    expect(await screen.findByText('Awaiting approval')).toBeInTheDocument();

    await actAs('Venue Operations');
    await openRow(user, 'Acme Trading Ltd');
    await approveForPool(user, 'USDC / EURC');
    await actAs('Alice Carter');
    await goTo(user, 'Onboarding');

    expect(
      await screen.findByRole('button', { name: 'Simulate registration' }),
    ).toBeInTheDocument();
  });

  it('shows the operator the ledger steps that approval produced', async () => {
    const { user, actAs } = renderApp();

    await submitApplication(user);
    await actAs('Venue Operations');
    await openRow(user, 'Acme Trading Ltd');
    await approveForPool(user, 'USDC / EURC');
    await actAs('Alice Carter');
    await goTo(user, 'Onboarding');
    await registerParty(user);
    await actAs('Venue Operations');
    await openRow(user, 'Acme Trading Ltd');

    const progress = await screen.findByText('Onboarding progress');
    const table = progress.closest('section')!;
    expect(await within(table).findByText('KYC attestation')).toBeInTheDocument();
    expect(within(table).getByText('Pool access, USDC / EURC')).toBeInTheDocument();
    expect(await screen.findByText('Completed', {}, LEDGER_WAIT)).toBeInTheDocument();
  });

  it('requires at least one pool before it will approve', async () => {
    const { user, actAs } = renderApp();

    await submitApplication(user);
    await actAs('Venue Operations');
    await openRow(user, 'Acme Trading Ltd');

    await user.click(await screen.findByRole('button', { name: /Accept with 0 pools/ }));
    expect(
      await screen.findByText('Select at least one pool'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: /USDC \/ EURC/ }));
    expect(screen.getByRole('button', { name: /Accept with 1 pool/ })).toBeInTheDocument();
  });

  it('grants no pool access when the operator rejects', async () => {
    const { user, actAs } = renderApp();

    await submitApplication(user);

    await actAs('Venue Operations');
    await openRow(user, 'Acme Trading Ltd');
    await rejectRequest(user);

    await actAs('Alice Carter');

    // The dashboard leads with the rejection and offers no way to trade.
    expect(await screen.findByText('Your application was rejected')).toBeInTheDocument();
    expect(await screen.findByText('Rejected')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request swap' })).not.toBeInTheDocument();

    await goTo(user, 'Swap');
    expect(await screen.findByText('No pools available to you')).toBeInTheDocument();
  });

  it('rejects an application with an invalid country code', async () => {
    const { user } = renderApp();

    await goTo(user, 'Onboarding');
    await user.type(await screen.findByLabelText('Legal name'), 'Acme Trading Ltd');
    await user.type(screen.getByLabelText('Country of incorporation'), 'P');
    await user.click(screen.getByRole('button', { name: 'Submit application' }));

    expect(
      await screen.findByText('Use a two-letter ISO country code, such as PT'),
    ).toBeInTheDocument();
    expect(
      await screen.findByText('Attach between 1 and 10 documents'),
    ).toBeInTheDocument();
  });

  it('keeps each trader to their own onboarding', async () => {
    const { user, actAs } = renderApp();

    await submitApplication(user);
    const aliceReference = (await screen.findByText(/^Reference onb-\d+$/)).textContent!;

    await actAs('Bob Sullivan');
    await goTo(user, 'Onboarding');
    expect(await screen.findByText('Sullivan Capital Partners LLC')).toBeInTheDocument();
    expect(screen.queryByText(aliceReference)).not.toBeInTheDocument();
    expect(screen.queryByText('Acme Trading Ltd')).not.toBeInTheDocument();
  });

  it('keeps the operator queue coherent after switching identities', async () => {
    const { user, actAs } = renderApp();

    await submitApplication(user);
    await actAs('Venue Operations');

    // Alice's new request sits beside the seeded one from Bob.
    expect(await screen.findByText('Acme Trading Ltd')).toBeInTheDocument();
    expect(screen.getByText('Sullivan Capital Partners LLC')).toBeInTheDocument();
  });
});

describe('the demo’s own registration', () => {
  it('registers the party in one step, and puts no key on the screen', async () => {
    const { user, actAs } = renderApp();
    await submitApplication(user);
    await actAs('Venue Operations');
    await openRow(user, 'Acme Trading Ltd');
    await approveForPool(user, 'USDC / EURC');
    await actAs('Alice Carter');
    await goTo(user, 'Onboarding');

    // The demo says what it is before it does anything.
    expect(await screen.findByText('Simulated ledger')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Simulate registration' }));

    expect(await screen.findByText('Registered')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/private|secret|seed|mnemonic/i);
    expect(screen.queryByRole('button', { name: 'Simulate registration' })).not.toBeInTheDocument();
  });
});

describe('what the operator is told after accepting', () => {
  async function acceptAlice(user: Parameters<typeof goTo>[0], actAs: (name: string) => Promise<void>) {
    await submitApplication(user);
    await actAs('Venue Operations');
    await openRow(user, 'Acme Trading Ltd');
    await approveForPool(user, 'USDC / EURC');
  }

  it('says the decision is saved, and that the party is still the trader’s step', async () => {
    const { user, actAs } = renderApp();
    await acceptAlice(user, actAs);

    // The status badge says the same thing, so this reads the callout itself.
    const accepted = (await screen.findByText('Accepted')).closest<HTMLElement>('.callout')!;
    expect(within(accepted).getByText('Not registered')).toBeInTheDocument();
    // Accepting never creates or signs anything on the trader's behalf.
    expect(screen.queryByText(/Party registered/)).not.toBeInTheDocument();
    // Nothing on the operator's screen narrates the venue's own plumbing.
    expect(document.body.textContent).not.toMatch(/Ledger API/);
  });

  it('stops saying the party is missing once the trader has registered it', async () => {
    const { user, actAs } = renderApp();
    await acceptAlice(user, actAs);

    await actAs('Alice Carter');
    await goTo(user, 'Onboarding');
    await registerParty(user);

    await actAs('Venue Operations');
    await openRow(user, 'Acme Trading Ltd');

    expect(await screen.findByText('Accepted')).toBeInTheDocument();
    expect(await screen.findByText(/Party registered/)).toBeInTheDocument();
    expect(screen.queryByText(/does not exist yet/)).not.toBeInTheDocument();
  });
});

describe('the operator queue on screen', () => {
  function rows(): string[] {
    const table = screen.getByRole('table');
    return Array.from(table.querySelectorAll<HTMLTableRowElement>('tbody tr')).map(
      (row) => row.cells[0]?.textContent ?? '',
    );
  }

  async function twoRequests(user: Parameters<typeof goTo>[0], actAs: (name: string) => Promise<void>) {
    // Alice applies after the seeded request, so she is the more recent one.
    await submitApplication(user);
    await actAs('Venue Operations');
    await screen.findByRole('table');
  }

  it('leads with the most recent request', async () => {
    const { user, actAs } = renderApp();
    await twoRequests(user, actAs);

    expect(rows()).toEqual(['Acme Trading Ltd', 'Sullivan Capital Partners LLC']);
    expect(screen.getByRole('columnheader', { name: /Submitted/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
  });

  it('sorts by any column the operator picks, and reverses on a second click', async () => {
    const { user, actAs } = renderApp();
    await twoRequests(user, actAs);

    await user.click(screen.getByRole('button', { name: /^Applicant, sort/ }));
    expect(rows()).toEqual(['Acme Trading Ltd', 'Sullivan Capital Partners LLC']);
    expect(screen.getByRole('columnheader', { name: /Applicant/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );

    await user.click(screen.getByRole('button', { name: /^Applicant, sort/ }));
    expect(rows()).toEqual(['Sullivan Capital Partners LLC', 'Acme Trading Ltd']);
    expect(screen.getByRole('columnheader', { name: /Applicant/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
  });

  it('marks only the column that is ordering the table', async () => {
    const { user, actAs } = renderApp();
    await twoRequests(user, actAs);

    await user.click(screen.getByRole('button', { name: /^Country, sort/ }));

    const sorted = screen
      .getAllByRole('columnheader')
      .filter((header) => header.getAttribute('aria-sort') !== 'none')
      .map((header) => header.textContent);
    expect(sorted).toEqual(['Country↑']);
  });

  it('keeps the order the operator chose while the queue refreshes', async () => {
    const { user, actAs } = renderApp();
    await twoRequests(user, actAs);

    await user.click(screen.getByRole('button', { name: /^Applicant, sort/ }));
    await user.click(screen.getByRole('button', { name: /^Applicant, sort/ }));
    expect(rows()[0]).toBe('Sullivan Capital Partners LLC');

    // The queue polls on its own; a new reading must not reset the ordering.
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    expect(rows()[0]).toBe('Sullivan Capital Partners LLC');
  });
});
