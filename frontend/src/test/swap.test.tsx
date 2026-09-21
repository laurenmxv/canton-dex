import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { fieldValue, onboardAlice } from './flows';
import { optionsOf, pick } from './listbox';
import { renderApp } from './harness';

/** The flow ends at a registered request. Nothing settles, nothing is credited. */
describe('swap request', () => {
  it('ends awaiting settlement without moving a single reserve', async () => {
    const { user, actAs } = renderApp();
    await onboardAlice(user, actAs);

    await user.click(screen.getByRole('button', { name: 'Swap' }));
    await user.type(await screen.findByLabelText('Amount in (USDC)'), '25000');
    await user.click(screen.getByRole('button', { name: 'Request quote' }));

    // 25000 USDC at 30 bps into the 4,200,000 / 3,885,000 pool.
    await screen.findByText('Expected output', { selector: 'dt' });
    const expected = Number(fieldValue('Expected output').replace(/[^\d.]/g, ''));
    const minimum = Number(fieldValue('Minimum output').replace(/[^\d.]/g, ''));
    expect(expected).toBeCloseTo(22919.60804, 4);
    expect(minimum).toBeLessThan(expected);
    expect(fieldValue('Fee')).toBe('75.00 USDC · 30 bps');
    expect(fieldValue('Quote expires')).toMatch(/in \d+m \d+s$/);

    await user.click(screen.getByRole('button', { name: 'Confirm these details' }));
    expect(await screen.findByText('Simulated wallet approval')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Approve and submit' }));

    await screen.findByText('Request', { selector: 'dt' });
    const requestId = fieldValue('Request');
    expect(requestId).toMatch(/^swap-\d+$/);
    // The step title, the step's status badge, and the row in the trader's list.
    expect(screen.getAllByText('Awaiting settlement')).toHaveLength(3);
    const requests = (await screen.findByText('Your swap requests')).closest<HTMLElement>('[data-slot="card"]')!;
    expect(within(requests).getByText(requestId)).toBeInTheDocument();
    // The pool the trader swapped against is untouched.
    await actAs('Venue Operations');
    await user.click(await screen.findByRole('button', { name: 'Pools' }));
    const live = (await screen.findByText('Live pools')).closest<HTMLElement>('[data-slot="card"]')!;
    const row = within(live).getByText('pool-usdc-eurc').closest('tr')!;
    expect(within(row).getByText('4,200,000.00 USDC')).toBeInTheDocument();
    expect(within(row).getByText('3,885,000.00 EURC')).toBeInTheDocument();
  });

  it('offers only the pools the operator approved', async () => {
    const { user, actAs } = renderApp();
    await onboardAlice(user, actAs);

    await user.click(screen.getByRole('button', { name: 'Swap' }));
    // The listbox builds its rows when it opens, so the offer is read there.
    const options = await optionsOf(user, 'Pool');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('USDC / EURC');
  });

  it('quotes the reverse direction in the other instrument', async () => {
    const { user, actAs } = renderApp();
    await onboardAlice(user, actAs);

    await user.click(screen.getByRole('button', { name: 'Swap' }));
    await pick(user, 'Direction', /^EURC to USDC/);

    expect(await screen.findByLabelText('Amount in (EURC)')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Amount in (EURC)'), '10000');
    await user.click(screen.getByRole('button', { name: 'Request quote' }));

    await screen.findByText('Expected output', { selector: 'dt' });
    expect(fieldValue('Expected output')).toMatch(/ USDC$/);
    expect(fieldValue('Fee')).toMatch(/^[\d,.]+ EURC · 30 bps$/);
  });

  it('offers no pools before onboarding completes', async () => {
    const { user } = renderApp();

    await user.click(await screen.findByRole('button', { name: 'Swap' }));

    expect(await screen.findByText('No pools available to you')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request quote' })).not.toBeInTheDocument();
  });

  it('treats a blank amount and a blank slippage as missing, not as zero', async () => {
    const { user, actAs } = renderApp();
    await onboardAlice(user, actAs);

    await user.click(screen.getByRole('button', { name: 'Swap' }));
    await user.clear(await screen.findByLabelText('Maximum slippage'));
    await user.click(screen.getByRole('button', { name: 'Request quote' }));

    expect(await screen.findByText('Enter an amount above zero')).toBeInTheDocument();
    expect(
      screen.getByText('Enter a slippage between 0 and 5000 bps'),
    ).toBeInTheDocument();
  });

  it('refuses a slippage beyond the ceiling', async () => {
    const { user, actAs } = renderApp();
    await onboardAlice(user, actAs);

    await user.click(screen.getByRole('button', { name: 'Swap' }));
    await user.type(await screen.findByLabelText('Amount in (USDC)'), '1000');
    await user.clear(screen.getByLabelText('Maximum slippage'));
    await user.type(screen.getByLabelText('Maximum slippage'), '9000');
    await user.click(screen.getByRole('button', { name: 'Request quote' }));

    expect(
      await screen.findByText('Enter a slippage between 0 and 5000 bps'),
    ).toBeInTheDocument();
  });
});
