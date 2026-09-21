import { screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';

/** Ledger confirmations arrive over several polls. */
export const LEDGER_WAIT = { timeout: 8000 };

/** Clicks a section in the sidebar. */
export async function goTo(user: UserEvent, label: string): Promise<void> {
  const nav = await screen.findByRole('navigation', { name: 'Sections' });
  await user.click(within(nav).getByRole('button', { name: label }));
}

/** Fills and submits the trader application form. */
export async function submitApplication(
  user: UserEvent,
  legalName = 'Acme Trading Ltd',
): Promise<void> {
  await goTo(user, 'Onboarding');
  await user.type(await screen.findByLabelText('Legal name'), legalName);
  await user.type(screen.getByLabelText('Country of incorporation'), 'PT');
  await user.click(screen.getByRole('checkbox', { name: /passport\.pdf/ }));
  await user.click(screen.getByRole('button', { name: 'Submit application' }));
}

/** Registers the trader's party the one way the demo can: by simulating it. */
export async function registerParty(user: UserEvent): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'Simulate registration' }));
}

/** Opens a table row by the button in its first cell, which reads as a link. */
export async function openRow(user: UserEvent, name: string): Promise<void> {
  await user.click(await screen.findByRole('button', { name }));
}

/** Approves the open request for a single named pool, keeping the suggested hint. */
export async function approveForPool(user: UserEvent, poolName: string): Promise<void> {
  await user.click(await screen.findByRole('checkbox', { name: new RegExp(poolName) }));
  await user.click(screen.getByRole('button', { name: /Accept with 1 pool/ }));
}

/** Rejects the open request, confirming the irreversible step. */
export async function rejectRequest(user: UserEvent): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'Reject' }));
  await user.click(await screen.findByRole('button', { name: 'Yes, reject' }));
}

/** Reads the value beside a label in a definition list. */
export function fieldValue(label: string): string {
  const term = screen.getByText(label, { selector: 'dt' });
  const value = term.nextElementSibling;
  if (!(value instanceof HTMLElement) || value.tagName !== 'DD') {
    const found = value?.tagName.toLowerCase() ?? 'nothing';
    throw new Error(`"${label}" is followed by <${found}>, not <dd>.`);
  }
  return value.textContent ?? '';
}

/**
 * Drives Alice through onboarding until she may trade one pool: apply, wait for
 * the operator's approval, then register her own party.
 */
export async function onboardAlice(
  user: UserEvent,
  actAs: (name: string) => Promise<void>,
  poolName = 'USDC / EURC',
): Promise<void> {
  await submitApplication(user);
  await actAs('Venue Operations');
  await openRow(user, 'Acme Trading Ltd');
  await approveForPool(user, poolName);
  await actAs('Alice Carter');
  await goTo(user, 'Onboarding');
  await registerParty(user);
  await screen.findByText('Completed', {}, LEDGER_WAIT);
}
