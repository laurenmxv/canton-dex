import { act, cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOCS_HOME } from '../features/docs/routes';
import { renderApp } from './harness';
import { PHONE_WIDTH, setViewportWidth } from './viewport';

const KEY = 'canton-dex.sidebar';

function sections() {
  return screen.getByRole('navigation', { name: 'Sections' });
}

async function collapsed() {
  const { user } = renderApp();
  await screen.findByRole('navigation', { name: 'Sections' });
  await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
  return user;
}

afterEach(() => window.history.replaceState(null, '', '/'));

describe('the collapsible sidebar', () => {
  it('collapses to named icons, keeps navigating, and expands again', async () => {
    const user = await collapsed();

    const buttons = within(sections()).getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual(['Dashboard', 'Swap', 'Onboarding']);
    for (const button of buttons) expect(within(button).getByText(button.textContent!)).toHaveClass('sr-only');

    await user.click(within(sections()).getByRole('button', { name: 'Swap' }));
    expect(await screen.findByRole('heading', { name: 'Request a swap' })).toBeInTheDocument();
    expect(within(sections()).getByRole('button', { name: 'Swap' })).toHaveAttribute('aria-current', 'page');

    await user.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    expect(within(sections()).getByText('Swap')).not.toHaveClass('sr-only');
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toBeInTheDocument();
  });

  it('widens around the icon rail before its labels arrive, and keeps focus on the toggle', async () => {
    const user = await collapsed();
    const column = sections().closest('aside')!;
    column.style.transitionDuration = '0.18s';

    await user.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    // The toggle already names its next action; the labels wait until the column is wide.
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toHaveFocus();
    expect(within(sections()).getByText('Swap')).toHaveClass('sr-only');

    const ended = new Event('transitionend', { bubbles: true });
    Object.defineProperty(ended, 'propertyName', { value: 'width' });
    act(() => void column.dispatchEvent(ended));
    expect(within(sections()).getByText('Swap')).not.toHaveClass('sr-only');
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toHaveFocus();
  });

  it('keeps keyboard focus on the toggle as it collapses and expands', async () => {
    const { user } = renderApp();
    await screen.findByRole('navigation', { name: 'Sections' });

    screen.getByRole('button', { name: 'Collapse sidebar' }).focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveFocus();

    await user.keyboard(' ');
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toHaveFocus();
  });

  it('names a rail icon when it takes keyboard focus', async () => {
    await collapsed();

    await act(async () => within(sections()).getByRole('button', { name: 'Swap' }).focus());

    expect(await screen.findByRole('tooltip', { name: 'Swap' })).toBeInTheDocument();
  });

  it('keeps identity, demo and theme controls one click away', async () => {
    const user = await collapsed();
    const aside = sections().closest('aside')!;
    expect(within(aside).queryByLabelText('Demo identity')).not.toBeInTheDocument();

    await user.click(within(aside).getByRole('button', { name: 'Account and settings' }));

    const panel = await screen.findByRole('dialog', { name: 'Account and settings' });
    expect(within(panel).getByLabelText('Demo identity')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Reset demo data' })).toBeInTheDocument();
    const dark = document.documentElement.classList.contains('dark');
    await user.click(within(panel).getByRole('button', { name: /Switch to (dark|light) theme/ }));
    expect(document.documentElement.classList.contains('dark')).toBe(!dark);
  });

  it('opens the docs from the rail', async () => {
    const user = await collapsed();
    const developer = screen.getByRole('navigation', { name: 'Developer' });

    await user.click(within(developer).getByRole('button', { name: 'Docs' }));

    expect(await screen.findByRole('heading', { name: 'Docs', level: 1 })).toBeInTheDocument();
    expect(window.location.hash).toBe(DOCS_HOME);
    expect(within(developer).getByRole('button', { name: 'Docs' })).toHaveAttribute('aria-current', 'page');
  });

  it('remembers the choice for the next visit', async () => {
    await collapsed();
    expect(window.localStorage.getItem(KEY)).toBe('collapsed');
    cleanup();

    renderApp();

    expect(await screen.findByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
  });

  it('still collapses where the browser refuses storage', async () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('Storage is disabled', 'SecurityError');
    });
    expect(() => window.localStorage).toThrow('Storage is disabled');

    await collapsed();

    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
  });

  it('still collapses where the browser refuses to read the stored choice', async () => {
    const read = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (key === KEY) throw new DOMException('Storage is disabled', 'SecurityError');
      return read.call(this, key);
    });
    expect(() => window.localStorage.getItem(KEY)).toThrow('Storage is disabled');

    await collapsed();

    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
  });

  it('keeps labels in the narrow drawer, whatever the wide column remembers', async () => {
    window.localStorage.setItem(KEY, 'collapsed');
    setViewportWidth(PHONE_WIDTH);
    const { user } = renderApp();

    await user.click(await screen.findByRole('button', { name: 'Menu' }));

    const drawer = await screen.findByRole('dialog', { name: 'Sections' });
    expect(within(drawer).getByText('Swap')).not.toHaveClass('sr-only');
    expect(within(drawer).queryByRole('button', { name: /(Collapse|Expand) sidebar/ })).not.toBeInTheDocument();
  });
});
