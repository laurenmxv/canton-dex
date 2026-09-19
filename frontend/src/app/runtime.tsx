import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AuthAdapter, AuthState } from '../auth/types';
import type { DemoApi, DemoControls, DexBackend, Identity } from '../lib/api/demo';
import type { DexClient } from '../lib/api/port';
import type { Profile } from '../lib/api/types';
import type { CantonWallet } from '../wallet/types';
import { useAsync } from './useAsync';

const ClientContext = createContext<DexClient | null>(null);
const WalletContext = createContext<CantonWallet | null>(null);
const DemoApiContext = createContext<DemoApi | null>(null);
const ControlsContext = createContext<DemoControls | null>(null);
const SessionContext = createContext<Session | null>(null);

export interface Session {
  /** How the signed-in identity was established. */
  mode: 'demo' | 'keycloak';
  /** The caller as the backend describes them, including their role. */
  current: Profile | undefined;
  loading: boolean;
  /** Present only where several actors can be chosen, as in the demo selector. */
  identities?: Identity[];
  switchTo?: (accountId: string) => void;
  /** Real sign-in surface. Absent in demo mode. */
  auth?: AuthState;
  login?: () => void;
  register?: () => void;
  logout?: () => void;
  /** The client could not say who the caller is. */
  profileError?: Error;
  retryProfile?: () => void;
}

/** Business screens and hooks reach the venue's surface only through this. */
export function useDexClient(): DexClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error('useDexClient requires a DexProvider');
  return client;
}

/**
 * The reader's own wallet. Null in the demo, which is what stops a simulated
 * world from ever opening MetaMask.
 */
export function useWallet(): CantonWallet | null {
  return useContext(WalletContext);
}

/**
 * The surfaces only the demo has. Null in real mode, which is what tells a
 * screen it has no business rendering simulated pools or swaps.
 */
export function useDemoApi(): DemoApi | null {
  return useContext(DemoApiContext);
}

/**
 * The demo surfaces, for a screen the real mode never routes to. Reaching for
 * this outside the demo is a wiring mistake, so it fails loudly.
 */
export function requireDemoApi(): DemoApi {
  const demo = useContext(DemoApiContext);
  if (!demo) throw new Error('useSimulatedApi is only available in demo mode');
  return demo;
}

/** Null whenever no demo controls are wired, as with the real client. */
export function useDemoControls(): DemoControls | null {
  return useContext(ControlsContext);
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession requires a DexProvider');
  return session;
}

/**
 * Neutral provider. It takes a client that is already built and a session that
 * is already resolved, so the real client is injected without demo controls and
 * without enumerating actors.
 */
export function DexProvider({
  client,
  session,
  controls = null,
  demo = null,
  wallet = null,
  children,
}: {
  client: DexClient | null;
  session: Session;
  controls?: DemoControls | null;
  demo?: DemoApi | null;
  wallet?: CantonWallet | null;
  children: ReactNode;
}) {
  return (
    <ControlsContext.Provider value={controls}>
      <DemoApiContext.Provider value={demo}>
        <WalletContext.Provider value={wallet}>
          <SessionContext.Provider value={session}>
            <ClientContext.Provider value={client}>{children}</ClientContext.Provider>
          </SessionContext.Provider>
        </WalletContext.Provider>
      </DemoApiContext.Provider>
    </ControlsContext.Provider>
  );
}

/** The caller's profile always comes from the client, never from a token claim. */
function useProfile(client: DexClient | null) {
  return useAsync(
    (signal) => (client ? client.me({ signal }) : Promise.resolve(undefined)),
    [client],
    { enabled: client !== null },
  );
}

/**
 * Offline wiring for UI work. An in-page selector chooses the actor, one shared
 * demo world backs every choice, and no network is involved.
 */
export function DemoRuntime({ backend, children }: { backend: DexBackend; children: ReactNode }) {
  const identities = useAsync(() => backend.controls.listIdentities(), [backend]);
  const [accountId, setAccountId] = useState<string>();

  const available = useMemo(() => identities.data ?? [], [identities.data]);
  const active = available.find((identity) => identity.accountId === accountId) ?? available[0];
  const bound = useMemo(
    () => (active ? backend.clientFor(active.accountId) : null),
    [backend, active],
  );
  const profile = useProfile(bound?.client ?? null);

  const session = useMemo<Session>(
    () => ({
      mode: 'demo',
      current: profile.data,
      loading: identities.loading || profile.loading,
      identities: available,
      switchTo: setAccountId,
      profileError: profile.error,
      retryProfile: profile.reload,
    }),
    [profile.data, profile.loading, profile.error, profile.reload, identities.loading, available],
  );

  return (
    // Keyed on the actor, so switching identity drops the previous actor's
    // screens at once rather than when their replacement's profile lands.
    <DexProvider
      key={active?.accountId ?? 'none'}
      client={bound?.client ?? null}
      demo={bound?.demo ?? null}
      session={session}
      controls={backend.controls}
    >
      {children}
    </DexProvider>
  );
}

/**
 * Real sign-in against the identity provider, with the venue serving the
 * business data.
 *
 * The profile comes from the API, so a valid identity the venue has not seen
 * before is provisioned by the backend rather than matched against a fixture.
 * A failed sign-in never falls back to the demo, and nobody can act as anyone
 * else.
 */
export function KeycloakRuntime({
  auth,
  client,
  wallet,
  children,
}: {
  auth: AuthAdapter;
  client: DexClient;
  wallet: CantonWallet;
  children: ReactNode;
}) {
  const [state, setState] = useState<AuthState>({
    status: 'starting',
    principal: null,
    error: null,
  });

  useEffect(() => {
    void auth.start(setState);
  }, [auth]);

  // Keyed on who is signed in, so a different principal, or none, rebuilds the
  // profile and every screen under it in the same commit. Nothing the previous
  // caller loaded can be on screen afterwards, and their reads are aborted.
  const principal = state.status === 'authenticated' ? state.principal : null;
  const identity = principal ? `${principal.issuer}|${principal.subject}` : 'anonymous';
  // A session the provider calls authenticated but cannot name is nobody: it
  // could not be told apart from the next one, so it is not signed in.
  const usable: AuthState =
    state.status === 'authenticated' && !principal
      ? { status: 'anonymous', principal: null, error: null }
      : state;

  return (
    <SignedInSession
      key={identity}
      auth={auth}
      client={client}
      wallet={wallet}
      state={usable}
      signedIn={principal !== null}
    >
      {children}
    </SignedInSession>
  );
}

function SignedInSession({
  auth,
  client,
  wallet,
  state,
  signedIn,
  children,
}: {
  auth: AuthAdapter;
  client: DexClient;
  wallet: CantonWallet;
  state: AuthState;
  /** Decided with the key above, so the two can never disagree. */
  signedIn: boolean;
  children: ReactNode;
}) {
  const profile = useProfile(signedIn ? client : null);

  const session = useMemo<Session>(
    () => ({
      mode: 'keycloak',
      current: profile.data,
      loading: state.status === 'starting' || (signedIn && profile.loading),
      auth: state,
      login: () => void auth.login(),
      register: () => void auth.register(),
      logout: () => void auth.logout(),
      profileError: profile.error,
      retryProfile: profile.reload,
    }),
    [auth, state, signedIn, profile.data, profile.loading, profile.error, profile.reload],
  );

  return (
    <DexProvider client={signedIn ? client : null} session={session} wallet={wallet}>
      {children}
    </DexProvider>
  );
}
