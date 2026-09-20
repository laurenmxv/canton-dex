import { useState, type ReactElement } from 'react';
import './app/shell.css';
import { useDemoApi, useDemoControls, useSession, type Session } from './app/runtime';
import { Sidebar } from './app/Sidebar';
import { Mark } from './app/Mark';
import { useTheme } from './app/useTheme';
import type { NextStepTarget } from './features/dashboard/nextStep';
import { TraderDashboard } from './features/dashboard/TraderDashboard';
import { OperatorOnboardingDetail } from './features/onboarding/OperatorOnboardingDetail';
import { OperatorOnboardingList } from './features/onboarding/OperatorOnboardingList';
import { TraderOnboarding } from './features/onboarding/TraderOnboarding';
import { OperatorPools } from './features/pools/OperatorPools';
import { VenuePools } from './features/pools/VenuePools';
import { ProposalDetail } from './features/pools/ProposalDetail';
import { OperatorSettlement } from './features/settlement/OperatorSettlement';
import { SwapDesk } from './features/swap/SwapDesk';
import { SwapRequestFlow } from './features/swap/SwapRequestFlow';
import type { Role } from './lib/api/types';
import { roleLabels } from './lib/labels';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { EmptyState, Loading } from './ui/States';

type View =
  | { name: 'trader-dashboard' }
  /** `poolId` is the pool the trader asked for, where they named one. */
  | { name: 'trader-swap'; poolId?: string }
  | { name: 'trader-onboarding' }
  | { name: 'operator-onboardings' }
  | { name: 'operator-onboarding'; onboardingId: string }
  | { name: 'operator-pools' }
  | { name: 'operator-settlement' }
  | { name: 'operator-proposal'; proposalId: string };

/** A view that has its own entry in the sidebar. Detail views do not. */
type Section = Exclude<View['name'], 'operator-onboarding' | 'operator-proposal'>;

type NavItem = { id: Section; label: string };

/**
 * Sections per role. Settlement is the venue's alone: the demo runs no queue
 * and settles nothing, so it has no such screen to offer.
 */
function navFor(role: Role, simulated: boolean): readonly NavItem[] {
  if (role === 'OPERATOR') {
    const sections: NavItem[] = [
      { id: 'operator-onboardings', label: 'Onboarding requests' },
      { id: 'operator-pools', label: 'Pools' },
    ];
    if (!simulated) sections.push({ id: 'operator-settlement', label: 'Settlement' });
    return sections;
  }
  return [
    { id: 'trader-dashboard', label: 'Dashboard' },
    { id: 'trader-swap', label: 'Swap' },
    { id: 'trader-onboarding', label: 'Onboarding' },
  ];
}

/** A detail view keeps its parent section highlighted. */
function sectionOf(view: View): Section {
  switch (view.name) {
    case 'operator-onboarding':
      return 'operator-onboardings';
    case 'operator-proposal':
      return 'operator-pools';
    default:
      return view.name;
  }
}

/** The one place a sidebar id becomes a view, so neither side needs a cast. */
const sectionViews: Record<Section, View> = {
  'trader-dashboard': { name: 'trader-dashboard' },
  'trader-swap': { name: 'trader-swap' },
  'trader-onboarding': { name: 'trader-onboarding' },
  'operator-onboardings': { name: 'operator-onboardings' },
  'operator-pools': { name: 'operator-pools' },
  'operator-settlement': { name: 'operator-settlement' },
};

export function App() {
  const session = useSession();
  const demo = useDemoApi();
  const controls = useDemoControls();
  const { dark, toggle } = useTheme();
  const [requested, setView] = useState<View>({ name: 'trader-dashboard' });
  const role = session.current?.role;
  const realLogin = session.mode === 'keycloak';
  // Demo mode is always signed in; real mode only once the provider says so.
  const signedIn = !realLogin || session.auth?.status === 'authenticated';

  // Resolved while rendering, not in an effect, so a role change never commits
  // one frame of the previous role's screen against the new account's client.
  const items = navFor(role ?? 'TRADER', demo !== null);
  const reachable = items.some((item) => item.id === sectionOf(requested));
  const view = reachable ? requested : sectionViews[items[0]!.id];

  return (
    <div className="app">
      {/* Only the demo needs a standing warning: everything it shows is made
          up. In real mode the screens say what is simulated where it matters,
          on the documents and on the signer. */}
      {realLogin ? null : (
        <div className="demo-bar">
          <strong>Demo session</strong>
          <span className="muted">Simulated identities, signatures and ledger results</span>
        </div>
      )}

      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <div className="shell">
        {session.current ? (
          <Sidebar
            items={items}
            activeId={sectionOf(view)}
            onSelect={(id) => setView(sectionViews[id])}
            footer={
              <SidebarFooter
                session={session}
                signedIn={signedIn}
                onResetDemo={
                  controls && signedIn
                    ? async () => {
                        if (!window.confirm('Clear every demo request, proposal and pool?')) return;
                        await controls.reset();
                        window.location.reload();
                      }
                    : undefined
                }
                dark={dark}
                onToggleTheme={toggle}
              />
            }
          />
        ) : null}

        <div className="content">
          <main
            className={`main${session.auth?.status === 'anonymous' ? ' main-welcome' : ''}`}
            id="main"
            tabIndex={-1}
          >
            {/* Keyed on the actor, so one trader's data never lands on another's screen. */}
            <AppBody
              key={session.current?.accountId ?? 'anonymous'}
              session={session}
              view={view}
              navigate={setView}
            />
          </main>
        </div>
      </div>
    </div>
  );
}

function SidebarFooter({
  session,
  signedIn,
  onResetDemo,
  dark,
  onToggleTheme,
}: {
  session: Session;
  signedIn: boolean;
  onResetDemo: (() => void) | undefined;
  dark: boolean;
  onToggleTheme: () => void;
}) {
  // A real session shows who is signed in. Only the demo can act as someone else.
  const choosable = session.switchTo && session.identities && session.identities.length > 0;

  return (
    <>
      {choosable ? (
        <div className="sidebar-identity">
          <label className="sr-only" htmlFor="identity-switcher">
            Demo identity
          </label>
          <select
            id="identity-switcher"
            className="control identity-select"
            value={session.current?.accountId ?? ''}
            onChange={(event) => session.switchTo?.(event.target.value)}
          >
            {session.identities!.map((identity) => (
              <option key={identity.accountId} value={identity.accountId}>
                {identity.displayName} · {roleLabels[identity.role]}
              </option>
            ))}
          </select>
        </div>
      ) : session.current ? (
        <div className="sidebar-identity">
          <span className="sidebar-identity-name">
            {/* The venue's own name for the caller, not a token claim. */}
            {session.current.displayName}
          </span>
          <span className="muted text-xs">{roleLabels[session.current.role]}</span>
        </div>
      ) : null}

      <div className="sidebar-actions">
        {session.logout && signedIn ? (
          <Button size="sm" variant="secondary" onClick={session.logout}>
            Sign out
          </Button>
        ) : null}
        {onResetDemo ? (
          <Button size="sm" variant="ghost" onClick={onResetDemo}>
            Reset demo data
          </Button>
        ) : null}
        <button
          type="button"
          className="theme-toggle"
          onClick={onToggleTheme}
          aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
        >
          {dark ? '☀' : '☾'}
        </button>
      </div>
    </>
  );
}

function AppBody({
  session,
  view,
  navigate,
}: {
  session: Session;
  view: View;
  navigate: (next: View) => void;
}) {
  const auth = session.auth;

  if (auth?.status === 'failed') {
    return (
      <Card padded>
        <EmptyState
          icon="!"
          title="Cannot reach the identity provider"
          description={auth.error?.message ?? 'Check your connection, then try again.'}
          action={<Button onClick={session.login}>Try again</Button>}
        />
      </Card>
    );
  }

  if (auth?.status === 'anonymous') {
    return (
      <section className="welcome" aria-labelledby="welcome-title">
        <header className="welcome-brand">
          <div className="welcome-mark"><Mark /></div>
          <h1 id="welcome-title">Canton DEX</h1>
        </header>
        <div className="welcome-card">
          <h2>Sign in to continue</h2>
          <p>Access your account, explore pools and manage your swaps.</p>
          <div className="welcome-actions">
            <Button className="btn-block" onClick={session.login}>
              Sign in <span aria-hidden="true">→</span>
            </Button>
            <Button className="btn-block" variant="secondary" onClick={session.register}>
              Create an account
            </Button>
          </div>
        </div>
        <p className="welcome-footer">Built on Canton Network</p>
      </section>
    );
  }

  if (session.profileError && !session.loading) {
    return (
      <Card padded>
        <EmptyState
          icon="!"
          title="Could not load your account"
          description={session.profileError.message}
          action={
            session.retryProfile ? (
              <Button variant="secondary" onClick={session.retryProfile}>
                Try again
              </Button>
            ) : null
          }
        />
      </Card>
    );
  }

  if (session.loading || !session.current) return <Loading label="Starting" />;

  return <ViewContent view={view} navigate={navigate} />;
}

function ViewContent({
  view,
  navigate,
}: {
  view: View;
  navigate: (next: View) => void;
}): ReactElement {
  // Only the demo serves swaps and its own pool proposals.
  const demo = useDemoApi();
  const goTrader = (target: NextStepTarget, poolId?: string) =>
    navigate(target === 'swap' ? { name: 'trader-swap', poolId } : { name: 'trader-onboarding' });

  switch (view.name) {
    case 'trader-dashboard':
      return <TraderDashboard onGo={goTrader} />;
    case 'trader-onboarding':
      return <TraderOnboarding />;
    case 'trader-swap':
      // The demo runs its own simulated flow; the venue's is the real one.
      return demo ? (
        <SwapRequestFlow
          initialPoolId={view.poolId}
          onGoToOnboarding={() => navigate({ name: 'trader-onboarding' })}
        />
      ) : (
        <SwapDesk
          initialPoolId={view.poolId}
          onGoToOnboarding={() => navigate({ name: 'trader-onboarding' })}
        />
      );
    case 'operator-onboardings':
      return (
        <OperatorOnboardingList
          onOpen={(onboardingId) => navigate({ name: 'operator-onboarding', onboardingId })}
        />
      );
    case 'operator-onboarding':
      return (
        <OperatorOnboardingDetail
          onboardingId={view.onboardingId}
          onBack={() => navigate({ name: 'operator-onboardings' })}
        />
      );
    case 'operator-pools':
      // The demo runs its own three-approval world; the venue's pools are real.
      return demo ? (
        <OperatorPools
          onOpenProposal={(proposalId) => navigate({ name: 'operator-proposal', proposalId })}
        />
      ) : (
        <VenuePools />
      );
    case 'operator-settlement':
      return <OperatorSettlement />;
    case 'operator-proposal':
      return (
        <ProposalDetail
          proposalId={view.proposalId}
          onBack={() => navigate({ name: 'operator-pools' })}
        />
      );
  }
}
