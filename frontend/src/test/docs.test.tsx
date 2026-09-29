import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { KeycloakRuntime } from '../app/runtime';
import type { AuthAdapter } from '../auth/types';
import { ARCHITECTURE_HOME, DOCS_HOME, FLOWS_HOME, flowHash } from '../features/docs/routes';
import * as flowSource from '../features/docs/flows/source';
import { testClient } from './clients';
import { goTo } from './flows';
import { renderApp } from './harness';
import { testWallet } from './wallets';

// jsdom cannot load the WebAssembly router; these tests cover navigation on the authored wires.
vi.mock('../features/docs/architecture/useRoutes', () => ({ useRoutes: () => null }));

/** The first visit loads the diagram chunk, which takes longer than a screen. */
const LOADED = { timeout: 15_000 };

function atlasHeading() {
  return screen.findByRole('heading', { name: 'Architecture Atlas' }, LOADED);
}

function docsIndex() {
  return screen.findByRole('heading', { name: 'Docs', level: 1 });
}

function atlasEntry() {
  return screen.getByRole('link', { name: /Architecture Atlas/ });
}

function openDocsFromSidebar(user: ReturnType<typeof userEvent.setup>) {
  return user.click(within(developerNav()).getByRole('button', { name: 'Docs' }));
}

function developerNav() {
  return screen.getByRole('navigation', { name: 'Developer' });
}

function layers() {
  return screen.getByRole('navigation', { name: 'Layers' });
}

function currentLayer() {
  return within(layers())
    .getAllByRole('button')
    .find((button) => button.getAttribute('aria-current') === 'page')?.textContent;
}

/** The Atlas is structural only: flows live on the Daml flows page. */
function expectNoFlowControls() {
  expect(screen.queryByRole('heading', { name: 'Flows' })).not.toBeInTheDocument();
  for (const name of ['Phase', 'Settlement', 'Deposit']) expect(screen.queryByRole('group', { name })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Trace' })).not.toBeInTheDocument();
  expect(screen.queryByRole('complementary', { name: 'Flows and details' })).not.toBeInTheDocument();
}

function anonymousAuth(): AuthAdapter & { login: () => Promise<void> } {
  return {
    start: async (onChange) => onChange({ status: 'anonymous', principal: null, error: null }),
    login: async () => {},
    register: async () => {},
    logout: async () => {},
    accessToken: async () => null,
  };
}

beforeEach(() => window.history.replaceState(null, '', '/'));
afterEach(() => window.history.replaceState(null, '', '/'));

describe('the developer docs', () => {
  it('open their index from the sidebar and close when the reader picks a section', async () => {
    const { user } = renderApp();
    await screen.findByRole('navigation', { name: 'Sections' });

    await openDocsFromSidebar(user);

    expect(await docsIndex()).toBeInTheDocument();
    expect(window.location.hash).toBe(DOCS_HOME);
    expect(atlasEntry()).toHaveAttribute('href', ARCHITECTURE_HOME);
    // The index loads no diagram.
    expect(screen.queryByRole('navigation', { name: 'Layers' })).not.toBeInTheDocument();
    expect(within(developerNav()).getByRole('button', { name: 'Docs' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getAllByRole('main')).toHaveLength(1);

    await goTo(user, 'Swap');

    expect(await screen.findByRole('heading', { name: 'Request a swap' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Docs', level: 1 })).not.toBeInTheDocument();
    expect(window.location.hash).toBe('');
  });

  it('open the Atlas from the index, and return by the breadcrumb or the sidebar', async () => {
    const { user } = renderApp();
    await screen.findByRole('navigation', { name: 'Sections' });
    await openDocsFromSidebar(user);
    await docsIndex();

    await user.click(atlasEntry());
    expect(await atlasHeading()).toBeInTheDocument();
    expect(window.location.hash).toBe(ARCHITECTURE_HOME);
    await user.click(within(layers()).getByRole('button', { name: 'Backend' }));

    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    await user.click(within(breadcrumb).getByRole('link', { name: 'Docs' }));
    expect(await docsIndex()).toBeInTheDocument();
    expect(window.location.hash).toBe(DOCS_HOME);

    await act(async () => window.history.back());
    expect(await atlasHeading()).toBeInTheDocument();
    expect(currentLayer()).toBe('Backend');

    await openDocsFromSidebar(user);
    expect(await docsIndex()).toBeInTheDocument();
    expect(window.location.hash).toBe(DOCS_HOME);
  });

  it('show an authored layer at once, and hold a routed layer until its wires are ready', async () => {
    window.history.replaceState(null, '', `/${ARCHITECTURE_HOME.replace(/system$/, 'backend')}`);
    const { user } = renderApp();
    await atlasHeading();
    const stage = () => screen.getByRole('region', { name: 'Architecture diagram' }).querySelector('.atlas-stage');

    expect(stage()).toHaveClass('is-shown');
    await user.click(within(layers()).getByRole('button', { name: 'All Layers' }));
    expect(currentLayer()).toBe('All Layers');
    // Routing is unavailable here, so the System layer waits, then shows its authored wires.
    expect(stage()).not.toHaveClass('is-shown');
    await waitFor(() => expect(stage()).toHaveClass('is-shown'), { timeout: 3000 });
  });

  it('open the Frontend layer from its container in the System diagram', async () => {
    window.history.replaceState(null, '', `/${ARCHITECTURE_HOME}`);
    const { user } = renderApp();
    await screen.findByRole('navigation', { name: 'Sections' });
    await atlasHeading();

    const diagram = screen.getByRole('region', { name: 'Architecture diagram' });
    const frontend = within(diagram).getByRole('group', { name: 'Frontend' });
    // user-event refuses a click that pointer-events: none would drop, as a real pointer does.
    await user.click(within(frontend).getByRole('button', { name: 'Frontend' }));

    expect(currentLayer()).toBe('Frontend');
  });

  it('offer no Canton view, and open System for an old Canton link', async () => {
    window.history.replaceState(null, '', '/#/dev/docs/architecture/canton?flow=pool-swap&branch=normal&phase=settle&settlementTrigger=manual&depositMode=proportional');
    renderApp();
    await screen.findByRole('navigation', { name: 'Sections' });
    await atlasHeading();

    expect(within(layers()).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'All Layers', 'Frontend', 'Client', 'Backend', 'Contracts',
    ]);
    expect(currentLayer()).toBe('All Layers');
    expect(window.location.hash).toBe(ARCHITECTURE_HOME);
    expectNoFlowControls();
    const runtime = within(screen.getByRole('region', { name: 'Architecture diagram' }))
      .getByRole('group', { name: 'Ledger runtime' });
    expect(within(runtime).queryByRole('button')).not.toBeInTheDocument();
  });

  it('explain a choice and its template separately, one tooltip at a time', async () => {
    window.history.replaceState(null, '', '/#/dev/docs/architecture/contracts');
    renderApp();
    await screen.findByRole('navigation', { name: 'Sections' });
    await atlasHeading();
    const diagram = within(screen.getByRole('region', { name: 'Architecture diagram' }));
    const texts = () => screen.queryAllByRole('tooltip').map((tip) => tip.textContent ?? '');

    await act(async () => diagram.getByText('Request swap').focus());
    await waitFor(() => expect(texts().length).toBeGreaterThan(0));
    expect(texts().every((text) => text.includes('PoolAccess_RequestSwap'))).toBe(true);
    expect(texts().some((text) => text.includes('Trader access'))).toBe(false);

    await act(async () => diagram.getByText('Request swap').blur());
    await act(async () => diagram.getByText('PoolAccess').focus());
    await waitFor(() => expect(texts().some((text) => text.includes('Trader access'))).toBe(true));
    expect(texts().some((text) => text.includes('PoolAccess_RequestSwap'))).toBe(false);
  });

  it('open the index for an unknown docs page', async () => {
    window.history.replaceState(null, '', '/#/dev/docs/unknown');
    renderApp();
    await screen.findByRole('navigation', { name: 'Sections' });

    expect(await docsIndex()).toBeInTheDocument();
    expect(atlasEntry()).toBeInTheDocument();
  });

  it('open an old flow link on its structural layer, and drop the flow from the URL', async () => {
    window.history.replaceState(
      null,
      '',
      '/#/dev/docs/architecture/backend?flow=pool-provide-liquidity&branch=normal&phase=all&settlementTrigger=manual&depositMode=initialize&focus=backend.swaps',
    );
    renderApp();
    // The demo remounts once its identity loads; the docs stay open throughout.
    await screen.findByRole('navigation', { name: 'Sections' });

    expect(await atlasHeading()).toBeInTheDocument();
    expect(currentLayer()).toBe('Backend');
    expect(window.location.hash).toBe('#/dev/docs/architecture/backend');
    expectNoFlowControls();
  });

  it('follow back and forward between trading, the index and the Atlas', async () => {
    const { user } = renderApp();
    await screen.findByRole('navigation', { name: 'Sections' });

    await openDocsFromSidebar(user);
    await docsIndex();
    await user.click(atlasEntry());
    await atlasHeading();
    await user.click(within(layers()).getByRole('button', { name: 'Contracts' }));
    expect(currentLayer()).toBe('Contracts');

    await act(async () => window.history.back());
    await waitFor(() => expect(currentLayer()).toBe('All Layers'));

    await act(async () => window.history.back());
    expect(await docsIndex()).toBeInTheDocument();

    await act(async () => window.history.back());
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Docs', level: 1 })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('navigation', { name: 'Sections' })).toBeInTheDocument();

    await act(async () => window.history.forward());
    expect(await docsIndex()).toBeInTheDocument();
    await act(async () => window.history.forward());
    expect(await atlasHeading()).toBeInTheDocument();
  });

  it('keep their link when the reader skips to the content', async () => {
    const link = '#/dev/docs/architecture/backend';
    window.history.replaceState(null, '', `/${link}`);
    const { user } = renderApp();
    await screen.findByRole('navigation', { name: 'Sections' });
    await atlasHeading();

    screen.getByRole('link', { name: 'Skip to content' }).focus();
    await user.keyboard('{Enter}');

    expect(screen.getByRole('main')).toHaveFocus();
    expect(window.location.hash).toBe(link);
    expect(currentLayer()).toBe('Backend');
  });

  it('ignore an in-page anchor in the URL', async () => {
    window.history.replaceState(null, '', `/${ARCHITECTURE_HOME}`);
    renderApp();
    await screen.findByRole('navigation', { name: 'Sections' });
    await atlasHeading();

    await act(async () => {
      window.location.hash = '#main';
    });

    expect(screen.getByRole('heading', { name: 'Architecture Atlas' })).toBeInTheDocument();
    expect(currentLayer()).toBe('All Layers');
  });
});

describe('the Daml flows', () => {
  const flowsNav = () => screen.getByRole('navigation', { name: 'Flows' });
  const current = () => within(flowsNav()).getAllByRole('button')
    .find((button) => button.getAttribute('aria-current') === 'page')?.textContent;
  const diagram = (title: string) => screen.findByRole('region', { name: `${title} diagram` }, LOADED);

  afterEach(() => {
    document.documentElement.classList.remove('dark');
  });

  it('open from the docs index on the first flow, rendered from its source', async () => {
    const { user } = renderApp();
    await screen.findByRole('navigation', { name: 'Sections' });
    await openDocsFromSidebar(user);
    await docsIndex();

    await user.click(screen.getByRole('link', { name: /Daml flows/ }));

    expect(await screen.findByRole('heading', { name: 'Daml flows' }, LOADED)).toBeInTheDocument();
    expect(window.location.hash).toBe(FLOWS_HOME);
    expect(within(flowsNav()).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Onboarding', 'Pool creation', 'Pool swap', 'Provide liquidity', 'Withdraw Liquidity',
    ]);
    expect(current()).toBe('Onboarding');
    expect((await diagram('Onboarding')).querySelector('.flow-step')).toBeInTheDocument();
    expect(await diagram('Onboarding')).toHaveTextContent('Submit KYC documents');
    expect(screen.getByRole('button', { name: 'Reading view' })).toBeInTheDocument();
  });

  it('switch flows through the URL, and follow a direct link and Back', async () => {
    window.history.replaceState(null, '', `/${flowHash('pool-provide-liquidity')}`);
    const { user } = renderApp();
    await screen.findByRole('navigation', { name: 'Sections' });
    expect(await diagram('Provide liquidity')).toBeInTheDocument();
    expect(current()).toBe('Provide liquidity');

    await user.click(within(flowsNav()).getByRole('button', { name: 'Pool swap' }));
    expect(window.location.hash).toBe(flowHash('pool-swap'));
    expect(await diagram('Pool swap')).toBeInTheDocument();

    await act(async () => window.history.back());
    expect(await diagram('Provide liquidity')).toBeInTheDocument();

    await act(async () => window.history.forward());
    expect(await diagram('Pool swap')).toBeInTheDocument();
    const swap = await diagram('Pool swap');
    await waitFor(() => {
      expect(swap).toHaveTextContent('PoolAccess_RequestSwap');
      expect(swap).toHaveTextContent('PoolAccess_RecoverAllocations');
      expect(swap).toHaveTextContent('VenueDelegation_SettleBatch');
    });
    expect(screen.queryByRole('navigation', { name: 'Flow sections' })).not.toBeInTheDocument();
    await act(async () => { window.location.hash = flowHash('pool-creation'); });
    expect(await diagram('Pool creation')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Flow sections' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Withdraw proposal/ })).not.toBeInTheDocument();
    expect(await screen.findByRole('group', { name: /Optional withdrawal.*While pending/ })).toBeInTheDocument();
  });

  it('keep native cards when the app theme changes', async () => {
    window.history.replaceState(null, '', `/${flowHash('pool-swap')}`);
    renderApp();
    await screen.findByRole('navigation', { name: 'Sections' });
    const region = await diagram('Pool swap');
    await waitFor(() => expect(region.querySelector('.flow-step')).toBeInTheDocument());
    const card = region.querySelector('.flow-step');
    expect(card).toBeInTheDocument();

    await act(async () => document.documentElement.classList.add('dark'));

    expect(screen.getByRole('region', { name: 'Pool swap diagram' }).querySelector('.flow-step')).toBe(card);
  });

  it('say which source failed instead of showing a substitute image', async () => {
    vi.spyOn(flowSource, 'parseFlow').mockImplementation(() => {
      throw new Error('docs/flows/pool-creation.puml: Unsupported activity statement');
    });
    window.history.replaceState(null, '', `/${flowHash('pool-creation')}`);
    renderApp();

    const alert = await screen.findByRole('alert', {}, LOADED);
    expect(alert).toHaveTextContent('docs/flows/pool-creation.puml: Unsupported activity statement');
    expect(screen.getByRole('main').querySelector('img')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Pool creation diagram' })).not.toBeInTheDocument();
  });
});

describe('the developer docs, signed out', () => {
  function renderSignedOut() {
    render(
      <KeycloakRuntime auth={anonymousAuth()} client={testClient({})} wallet={testWallet()}>
        <App />
      </KeycloakRuntime>,
    );
    return userEvent.setup();
  }

  it('open from the welcome screen without a session, and lead back to sign-in', async () => {
    const user = renderSignedOut();

    await user.click(await screen.findByRole('button', { name: 'Developer docs' }));

    expect(await docsIndex()).toBeInTheDocument();
    await user.click(atlasEntry());
    expect(await atlasHeading()).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Sections' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Demo identity')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Switch to (dark|light) theme/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Sign in to continue')).toBeInTheDocument();
    expect(window.location.hash).toBe('');
  });

  it('open a direct link before the provider answers', async () => {
    window.history.replaceState(null, '', `/${ARCHITECTURE_HOME}`);
    const pending: AuthAdapter = { ...anonymousAuth(), start: () => new Promise(() => {}) };
    render(
      <KeycloakRuntime auth={pending} client={testClient({})} wallet={testWallet()}>
        <App />
      </KeycloakRuntime>,
    );

    expect(await atlasHeading()).toBeInTheDocument();
    expect(screen.queryByText('Starting…')).not.toBeInTheDocument();
  });
});
