import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { KeycloakRuntime } from '../app/runtime';
import { createKeycloakAuth } from '../auth/keycloak';
import type { AuthAdapter, AuthState } from '../auth/types';
import type { DexClient } from '../lib/api/port';
import type { CantonWallet } from '../wallet/types';
import { testClient } from './clients';
import { testWallet } from './wallets';
import type { Profile } from '../lib/api/types';

/**
 * keycloak-js, under the tests that run the real adapter. What a test's `init`
 * leaves on the instance is what the provider found.
 */
const provider = vi.hoisted(() => ({
  init: vi.fn<(keycloak: FakeKeycloak, options?: { onLoad?: string }) => Promise<boolean>>(),
}));

interface FakeKeycloak {
  authenticated: boolean;
  tokenParsed: object | undefined;
  clearToken(): void;
}

vi.mock('keycloak-js', () => ({
  default: class {
    authenticated = false;
    tokenParsed: object | undefined;
    onAuthLogout?: () => void;
    init(options?: { onLoad?: string }) {
      return provider.init(this, options);
    }
    /** As keycloak-js does when a token can no longer be refreshed. */
    clearToken() {
      this.authenticated = false;
      this.tokenParsed = undefined;
      this.onAuthLogout?.();
    }
  },
}));

const DAVID: Profile = {
  accountId: 'b2e4f6a8-0000-4000-8000-000000000002',
  displayName: 'David Whitfield',
  role: 'TRADER',
  partyId: null,
};

type Stub = AuthAdapter & {
  login: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
};

function stubAuth(state: AuthState): Stub {
  return {
    start: async (onChange) => onChange(state),
    login: vi.fn(async () => {}),
    register: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    accessToken: async () => 'stub-token',
  };
}

/** A venue that answers every read, so only the session behaviour is under test. */
type ClientParts = Parameters<typeof testClient>[0];

function stubClient(overrides: ClientParts = {}): DexClient {
  return testClient({
    me: () => Promise.resolve(DAVID),
    ...overrides,
    onboarding: { mine: () => Promise.resolve(null), ...overrides.onboarding },
    pools: { list: () => Promise.resolve([]), ...overrides.pools },
    admin: { listOnboardings: () => Promise.resolve([]), ...overrides.admin },
  });
}

/** A wallet nothing in these tests reaches for; the session is what is under test. */
const IDLE_WALLET: CantonWallet = testWallet();

function authenticated(subject: string): AuthState {
  return {
    status: 'authenticated',
    principal: { issuer: 'http://localhost:18082/realms/Dex', subject, username: subject },
    error: null,
  };
}

function renderWithAuth(auth: AuthAdapter, client: DexClient = stubClient()) {
  render(
    <KeycloakRuntime auth={auth} client={client} wallet={IDLE_WALLET}>
      <App />
    </KeycloakRuntime>,
  );
  return userEvent.setup();
}

describe('real sign-in', () => {
  it('asks an anonymous visitor to sign in and offers no simulated identities', async () => {
    const auth = stubAuth({ status: 'anonymous', principal: null, error: null });
    const user = renderWithAuth(auth);

    expect(await screen.findByText('Sign in to continue')).toBeInTheDocument();
    expect(screen.queryByLabelText('Demo identity')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(auth.login).toHaveBeenCalledOnce();
  });

  it('sends a new visitor to the provider to create their own account', async () => {
    const auth = stubAuth({ status: 'anonymous', principal: null, error: null });
    const user = renderWithAuth(auth);

    await user.click(await screen.findByRole('button', { name: 'Create an account' }));

    expect(auth.register).toHaveBeenCalledOnce();
    // The webapp collects no password of its own.
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
  });

  it('does not claim a session it does not have', async () => {
    renderWithAuth(stubAuth({ status: 'anonymous', principal: null, error: null }));

    expect(await screen.findByText('Sign in to continue')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Sections' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
  });

  it('reports a failed sign-in instead of falling back to the demo', async () => {
    renderWithAuth(
      stubAuth({
        status: 'failed',
        principal: null,
        error: new Error('Could not reach the identity provider at http://localhost:18082.'),
      }),
    );

    expect(await screen.findByText('Cannot reach the identity provider')).toBeInTheDocument();
    // What the reader can do about it, rather than how the app is built.
    expect(screen.getByText(/Could not reach the identity provider at/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Demo identity')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Onboarding' })).not.toBeInTheDocument();
  });

  it('takes the caller and their role from the venue, not from the token', async () => {
    const me = vi.fn(() => Promise.resolve(DAVID));
    renderWithAuth(
      stubAuth({
        status: 'authenticated',
        principal: {
          issuer: 'http://localhost:18082/realms/Dex',
          subject: 'c0ffee00-dead-beef-0000-000000000000',
          username: 'david',
        },
        error: null,
      }),
      stubClient({ me }),
    );

    // A subject the venue has never seen still gets a profile, because the
    // backend provisions one. Nothing here maps a principal to a fixture.
    expect(await screen.findByText('David Whitfield')).toBeInTheDocument();
    expect(screen.getByText('Trader')).toBeInTheDocument();
    expect(me).toHaveBeenCalled();
    expect(screen.queryByLabelText('Demo identity')).not.toBeInTheDocument();
  });

  it('shows a trader only the sections the venue can serve', async () => {
    renderWithAuth(stubAuth(authenticated('david')));

    const nav = await screen.findByRole('navigation', { name: 'Sections' });
    const sections = Array.from(nav.querySelectorAll('button')).map((button) => button.textContent);
    expect(sections).toEqual(['Dashboard', 'Swap', 'Liquidity', 'Onboarding', 'Faucet']);
  });

  it('shows an operator the sections the venue serves, and no trader screen', async () => {
    renderWithAuth(
      stubAuth(authenticated('david')),
      stubClient({
        me: () => Promise.resolve({ ...DAVID, role: 'OPERATOR' }),
        admin: {
          listOnboardings: () => Promise.resolve([]),
          listPoolProposals: () => Promise.resolve([]),
          listPools: () => Promise.resolve([]),
        },
      }),
    );

    const nav = await screen.findByRole('navigation', { name: 'Sections' });
    const sections = Array.from(nav.querySelectorAll('button')).map((button) => button.textContent);
    expect(sections).toEqual(['Onboarding requests', 'Pools', 'Settlement']);
  });

  it('reports a profile the client cannot load, instead of waiting forever', async () => {
    const me = vi.fn(() => Promise.reject(new Error('The venue is unreachable')));
    const user = renderWithAuth(
      stubAuth(authenticated('david')),
      stubClient({ me }),
    );

    expect(await screen.findByText('Could not load your account')).toBeInTheDocument();
    expect(screen.getByText('The venue is unreachable')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(me.mock.calls.length).toBeGreaterThan(1));
  });

  it('drops the previous caller the moment a different principal signs in', async () => {
    let publish: ((state: AuthState) => void) | undefined;
    const auth: AuthAdapter = {
      start: async (onChange) => {
        publish = onChange;
        onChange(authenticated('alice'));
      },
      login: async () => {},
      register: async () => {},
      logout: async () => {},
      accessToken: async () => 'stub-token',
    };
    let held: (() => void) | undefined;
    const profiles: Record<string, Profile> = {
      alice: { ...DAVID, accountId: 'alice', displayName: 'Alice Carter' },
      bob: { ...DAVID, accountId: 'bob', displayName: 'Bob Sullivan' },
    };
    let who = 'alice';
    render(
      <KeycloakRuntime
        auth={auth}
        client={stubClient({
          me: async () => {
            const answer = profiles[who]!;
            // The second caller's answer is slow, so the gap is observable.
            if (who === 'bob') await new Promise<void>((resolve) => (held = resolve));
            return answer;
          },
        })}
        wallet={IDLE_WALLET}
      >
        <App />
      </KeycloakRuntime>,
    );

    expect(await screen.findByText('Alice Carter')).toBeInTheDocument();

    who = 'bob';
    await act(async () => publish!(authenticated('bob')));

    // Alice is gone before Bob's profile lands, not after.
    expect(screen.queryByText('Alice Carter')).not.toBeInTheDocument();
    await act(async () => held!());
    expect(await screen.findByText('Bob Sullivan')).toBeInTheDocument();
  });

  it('keeps nothing of the caller once they are no longer signed in', async () => {
    let publish: ((state: AuthState) => void) | undefined;
    const auth: AuthAdapter = {
      start: async (onChange) => {
        publish = onChange;
        onChange(authenticated('alice'));
      },
      login: async () => {},
      register: async () => {},
      logout: async () => {},
      accessToken: async () => 'stub-token',
    };
    render(
      <KeycloakRuntime auth={auth} client={stubClient()} wallet={IDLE_WALLET}>
        <App />
      </KeycloakRuntime>,
    );

    expect(await screen.findByText('David Whitfield')).toBeInTheDocument();

    await act(async () => publish!({ status: 'anonymous', principal: null, error: null }));

    expect(screen.queryByText('David Whitfield')).not.toBeInTheDocument();
    expect(await screen.findByText('Sign in to continue')).toBeInTheDocument();
  });

  it('signs out through the adapter', async () => {
    const auth = stubAuth(authenticated('david'));
    const user = renderWithAuth(auth);

    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(auth.logout).toHaveBeenCalledOnce();
  });
});

describe('the Keycloak adapter, when the runtime mounts again', () => {
  const CONFIG = { url: 'http://localhost:18082', realm: 'Dex', clientId: 'dex-web' };

  /** An init that finds a session, as check-sso does for a caller already signed in. */
  async function findsDavid(keycloak: FakeKeycloak) {
    keycloak.authenticated = true;
    keycloak.tokenParsed = { sub: 'david', preferred_username: 'david' };
    return true;
  }

  /** The runtime as main.tsx mounts it. HMR unmounts it and mounts it again. */
  function mount(auth: AuthAdapter) {
    return render(
      <StrictMode>
        <KeycloakRuntime auth={auth} client={stubClient()} wallet={IDLE_WALLET}>
          <App />
        </KeycloakRuntime>
      </StrictMode>,
    );
  }

  it.each([
    ['a session', findsDavid, 'David Whitfield'],
    ['no session', async () => false, 'Sign in to continue'],
    ['a failed start', () => Promise.reject(new Error('Network down')), 'Cannot reach the identity provider'],
  ])('tells it of %s, without asking the provider twice', async (_, init, shown) => {
    provider.init.mockImplementation(init);
    const auth = createKeycloakAuth(CONFIG);

    const first = mount(auth);
    expect(await screen.findByText(shown)).toBeInTheDocument();
    first.unmount();

    mount(auth);
    expect(await screen.findByText(shown)).toBeInTheDocument();
    expect(provider.init).toHaveBeenCalledOnce();
  });

  it('checks for a signed-in session by default, and skips the check when told to', async () => {
    provider.init.mockImplementation(async () => false);

    const trading = mount(createKeycloakAuth(CONFIG));
    expect(await screen.findByText('Sign in to continue')).toBeInTheDocument();
    trading.unmount();
    mount(createKeycloakAuth(CONFIG, { checkSso: false }));
    expect(await screen.findByText('Sign in to continue')).toBeInTheDocument();

    expect(provider.init.mock.calls.map(([, options]) => options?.onLoad)).toEqual([
      'check-sso',
      undefined,
    ]);
  });

  it('answers the runtime mounted while the first start still runs', async () => {
    let finish: (() => void) | undefined;
    provider.init.mockImplementation(
      (keycloak) => new Promise((resolve) => (finish = () => resolve(findsDavid(keycloak)))),
    );
    const auth = createKeycloakAuth(CONFIG);

    mount(auth).unmount();
    mount(auth);
    expect(screen.getByText('Starting…')).toBeInTheDocument();

    await act(async () => finish!());
    expect(await screen.findByText('David Whitfield')).toBeInTheDocument();
    expect(provider.init).toHaveBeenCalledOnce();
  });

  it('does not bring back a session the provider has since ended', async () => {
    let keycloak: FakeKeycloak | undefined;
    provider.init.mockImplementation((instance) => {
      keycloak = instance;
      return findsDavid(instance);
    });
    const auth = createKeycloakAuth(CONFIG);

    const first = mount(auth);
    expect(await screen.findByText('David Whitfield')).toBeInTheDocument();
    await act(async () => keycloak!.clearToken());
    expect(await screen.findByText('Sign in to continue')).toBeInTheDocument();
    first.unmount();

    mount(auth);
    expect(await screen.findByText('Sign in to continue')).toBeInTheDocument();
    expect(screen.queryByText('David Whitfield')).not.toBeInTheDocument();
  });
});

describe('a token the venue cannot tell apart', () => {
  it('is refused rather than collapsing two callers onto one session', async () => {
    renderWithAuth(
      stubAuth({
        status: 'authenticated',
        // A state with no principal cannot key one caller apart from another.
        principal: null,
        error: null,
      }),
    );

    expect(await screen.findByText('Sign in to continue')).toBeInTheDocument();
    expect(screen.queryByText('David Whitfield')).not.toBeInTheDocument();
  });
});

describe('the standing banner', () => {
  it('is gone in real mode, where the screens say what is simulated themselves', async () => {
    renderWithAuth(stubAuth(authenticated('david')));

    await screen.findByText('David Whitfield');
    expect(screen.queryByText('Real login')).not.toBeInTheDocument();
    expect(screen.queryByText(/resulting ledger contracts are real/)).not.toBeInTheDocument();
    expect(screen.queryByText('Demo session')).not.toBeInTheDocument();
  });

  it('is gone before signing in too', async () => {
    renderWithAuth(stubAuth({ status: 'anonymous', principal: null, error: null }));

    await screen.findByText('Sign in to continue');
    expect(screen.queryByText('Keycloak sign-in')).not.toBeInTheDocument();
  });
});
