import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';
import { DemoRuntime } from '../app/runtime';
import { createFixtureBackend } from '../mocks/client';
import { pick } from './listbox';
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
    await pick(user, 'Demo identity', new RegExp(`^${displayName}`));
  }

  return { user, actAs };
}
