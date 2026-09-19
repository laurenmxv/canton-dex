import { act, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { roleLabels } from '../lib/labels';
import { goTo, openRow, submitApplication } from './flows';
import { renderApp } from './harness';
import { PHONE_WIDTH, setViewportWidth } from './viewport';

function nav(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Sections' });
}

function sidebar(): HTMLElement {
  return nav().closest('aside')!;
}

function sections(): string[] {
  return within(nav())
    .getAllByRole('button')
    .map((button) => button.textContent ?? '');
}

function activeSection(): string | undefined {
  return (
    within(nav())
      .getAllByRole('button')
      .find((button) => button.getAttribute('aria-current') === 'page')?.textContent ?? undefined
  );
}

describe('the demo warning', () => {
  it('stays where everything on screen is made up', async () => {
    renderApp();
    // The tree remounts once the actor is chosen, so settle before asserting.
    await screen.findByRole('navigation', { name: 'Sections' });

    expect(screen.getByText('Demo session')).toBeInTheDocument();
    expect(
      screen.getByText(/Identities, approvals, signatures and ledger results/),
    ).toBeInTheDocument();
  });
});

describe('the sidebar', () => {
  it('offers each role only its own sections', async () => {
    const { actAs } = renderApp();

    await screen.findByRole('navigation', { name: 'Sections' });
    expect(sections()).toEqual(['Dashboard', 'Swap', 'Onboarding']);

    await actAs('Venue Operations');
    expect(sections()).toEqual(['Onboarding requests', 'Pools']);
  });

  it('marks the section the reader is in', async () => {
    const { user } = renderApp();

    await screen.findByRole('navigation', { name: 'Sections' });
    expect(activeSection()).toBe('Dashboard');

    await goTo(user, 'Swap');
    expect(activeSection()).toBe('Swap');
    expect(await screen.findByRole('heading', { name: 'Request a swap' })).toBeInTheDocument();
  });

  it('keeps the parent section marked inside a detail view', async () => {
    const { user, actAs } = renderApp();
    await actAs('Venue Operations');

    await goTo(user, 'Pools');
    expect(activeSection()).toBe('Pools');

    await openRow(user, 'TBILL / USDC');
    expect(await screen.findByRole('heading', { name: 'TBILL / USDC' })).toBeInTheDocument();
    expect(activeSection()).toBe('Pools');
  });

  it('carries the identity, the role and the way out, inside the sidebar', async () => {
    const { actAs } = renderApp();
    await screen.findByRole('navigation', { name: 'Sections' });

    expect(within(sidebar()).getByLabelText('Demo identity')).toBeInTheDocument();

    await actAs('Venue Operations');

    // Switching identity rebuilds the screen, so the control is a new one.
    const foot = within(sidebar());
    const identity = foot.getByLabelText('Demo identity');
    expect(identity).toHaveValue('acc-operator');
    // The role travels with the identity, so the reader always knows which one.
    expect(within(identity).getByRole('option', { selected: true })).toHaveTextContent(
      `Venue Operations · ${roleLabels.OPERATOR}`,
    );
    // The demo switcher stands in for signing out; a real session gets a button.
    expect(foot.getByRole('button', { name: 'Reset demo data' })).toBeInTheDocument();
    expect(foot.getByRole('button', { name: /Switch to (dark|light) theme/ })).toBeInTheDocument();
  });

  it('sends a role to its own first screen, and never renders the other role’s', async () => {
    const { user, actAs } = renderApp();

    await goTo(user, 'Swap');
    await actAs('Venue Operations');

    expect(activeSection()).toBe('Onboarding requests');
    expect(screen.queryByRole('heading', { name: 'Request a swap' })).not.toBeInTheDocument();
  });

  it('keeps an onboarding detail view on its parent section', async () => {
    const { user, actAs } = renderApp();
    await submitApplication(user);

    await actAs('Venue Operations');
    await openRow(user, 'Acme Trading Ltd');

    expect(await screen.findByRole('heading', { name: 'Acme Trading Ltd' })).toBeInTheDocument();
    expect(activeSection()).toBe('Onboarding requests');
  });
});

describe('the sidebar on a narrow viewport', () => {
  it('hides behind a menu button, and opens on demand', async () => {
    setViewportWidth(PHONE_WIDTH);
    const { user } = renderApp();

    const menu = await screen.findByRole('button', { name: /Menu/ });
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('navigation', { name: 'Sections' })).not.toBeInTheDocument();

    await user.click(menu);

    expect(screen.getByRole('dialog', { name: 'Sections' })).toBeInTheDocument();
    expect(menu).toHaveAttribute('aria-expanded', 'true');
    expect(sections()).toEqual(['Dashboard', 'Swap', 'Onboarding']);
  });

  it('moves focus into the drawer, and returns it on Escape', async () => {
    setViewportWidth(PHONE_WIDTH);
    const { user } = renderApp();

    const menu = await screen.findByRole('button', { name: 'Menu' });
    await user.click(menu);

    // The first stop, not merely somewhere inside.
    expect(screen.getByRole('button', { name: 'Close menu' })).toHaveFocus();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Menu' })).toHaveFocus();
  });

  it('offers a close button a screen reader can reach inside the drawer', async () => {
    setViewportWidth(PHONE_WIDTH);
    const { user } = renderApp();

    await user.click(await screen.findByRole('button', { name: 'Menu' }));
    const drawer = screen.getByRole('dialog', { name: 'Sections' });
    const close = within(drawer).getByRole('button', { name: 'Close menu' });

    await user.click(close);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Menu' })).toHaveFocus();
  });

  it('closes when the reader clicks away from the drawer', async () => {
    setViewportWidth(PHONE_WIDTH);
    const { user } = renderApp();

    await user.click(await screen.findByRole('button', { name: 'Menu' }));
    await user.click(document.querySelector('.scrim')!);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps Tab inside the drawer while it is open', async () => {
    setViewportWidth(PHONE_WIDTH);
    const { user } = renderApp();

    await user.click(await screen.findByRole('button', { name: /Menu/ }));
    const drawer = screen.getByRole('dialog', { name: 'Sections' });

    // Shift+Tab off the first stop wraps to the last, not out of the drawer.
    await user.tab({ shift: true });
    const stops = within(drawer).getAllByRole('button');
    expect(stops[stops.length - 1]).toHaveFocus();

    for (let press = 0; press < 12; press += 1) await user.tab();
    expect(drawer).toContainElement(document.activeElement as HTMLElement);
  });

  it('closes once the reader picks a section', async () => {
    setViewportWidth(PHONE_WIDTH);
    const { user } = renderApp();

    await user.click(await screen.findByRole('button', { name: /Menu/ }));
    await user.click(screen.getByRole('button', { name: 'Swap' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Request a swap' })).toBeInTheDocument();
  });

  it('returns to a column once the viewport is wide again', async () => {
    setViewportWidth(PHONE_WIDTH);
    const { user } = renderApp();

    await user.click(await screen.findByRole('button', { name: /Menu/ }));
    expect(screen.getByRole('dialog', { name: 'Sections' })).toBeInTheDocument();

    // A resize is a browser event, so React needs an act boundary to flush it.
    await act(async () => setViewportWidth(1280));

    expect(await screen.findByRole('navigation', { name: 'Sections' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Menu' })).not.toBeInTheDocument();
    // The toggle is gone, so focus must land in the column rather than on body.
    expect(sidebar()).toContainElement(document.activeElement as HTMLElement);
  });
});
