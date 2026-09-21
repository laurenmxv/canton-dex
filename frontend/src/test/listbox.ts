import { screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';

/**
 * Opens one of the kit's listboxes and returns the rows it offers.
 *
 * The control is a button that opens a list, not a native `select`, so a test
 * drives it the way a reader does.
 */
export async function optionsOf(user: UserEvent, label: string): Promise<HTMLElement[]> {
  const trigger = await screen.findByLabelText(label);
  await user.click(trigger);
  const listbox = await screen.findByRole('listbox').catch(() => {
    throw new Error(`"${label}" opened no listbox; its role is "${trigger.getAttribute('role')}".`);
  });
  return within(listbox).getAllByRole('option');
}

/**
 * Picks a value from one of the kit's listboxes, by the row's accessible name.
 *
 * The query stays `getByRole('option', { name })`, so the name is computed the
 * way assistive technology computes it, and two rows answering to the same
 * name are an error rather than a silent first match. The catch only adds what
 * was on offer, which is what a reader needs right after a change to which
 * rows render.
 */
export async function pick(user: UserEvent, label: string, option: string | RegExp): Promise<void> {
  const trigger = await screen.findByLabelText(label);
  await user.click(trigger);
  const listbox = await screen.findByRole('listbox').catch(() => {
    throw new Error(`"${label}" opened no listbox; its role is "${trigger.getAttribute('role')}".`);
  });

  const rows = within(listbox);
  let wanted: HTMLElement;
  try {
    wanted = rows.getByRole('option', { name: option });
  } catch (cause) {
    const offered = rows
      .getAllByRole('option')
      .map((row) => row.textContent)
      .join(', ');
    throw new Error(`"${label}" offers: ${offered}. ${(cause as Error).message}`);
  }
  await user.click(wanted);
}
