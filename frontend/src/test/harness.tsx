import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';
import { DemoRuntime } from '../app/runtime';
import { createFixtureBackend } from '../mocks/client';
import '../styles/global.css';

/** Renders the whole app against a fresh demo world with no simulated latency. */
export function renderApp() {
  const user = userEvent.setup();
  render(
    <DemoRuntime backend={createFixtureBackend({ latencyMs: 0 })}>
      <App />
    </DemoRuntime>,
  );

  async function actAs(displayName: string) {
    const switcher = await screen.findByLabelText('Demo identity');
    const option = Array.from(switcher.querySelectorAll('option')).find((candidate) =>
      candidate.textContent?.startsWith(displayName),
    );
    if (!option) throw new Error(`No demo identity named ${displayName}`);
    await user.selectOptions(switcher, option.value);
  }

  return { user, actAs };
}
