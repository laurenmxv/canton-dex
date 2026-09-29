import { Button } from '@openzeppelin/ui-components';
import { lazy, Suspense, useState, type ReactElement } from 'react';
import { useDemoApi, useDemoControls, useSession, type Session } from './app/runtime';
import { Sidebar } from './app/Sidebar';
import { Mark } from './app/Mark';
import { useDocsRoute } from './app/useDocsRoute';
import { useTheme } from './app/useTheme';
import type { NextStepTarget } from './features/dashboard/nextStep';
import { TraderDashboard } from './features/dashboard/TraderDashboard';
import { LiquidityDesk } from './features/liquidity/LiquidityDesk';
import { OperatorOnboardingDetail } from './features/onboarding/OperatorOnboardingDetail';
import { OperatorOnboardingList } from './features/onboarding/OperatorOnboardingList';
import { TraderOnboarding } from './features/onboarding/TraderOnboarding';
import { OperatorPools } from './features/pools/OperatorPools';
import { VenuePools } from './features/pools/VenuePools';
import { ProposalDetail } from './features/pools/ProposalDetail';
import { OperatorSettlement } from './features/settlement/OperatorSettlement';
import { Faucet } from './features/tokens/Faucet';
import { FAUCET_SECTION } from './features/tokens/navigation';
import { SwapDesk } from './features/swap/SwapDesk';
import { SwapRequestFlow } from './features/swap/SwapRequestFlow';
import type { Role } from './lib/api/types';
import { roleLabels } from './lib/labels';
import { Card } from './ui/Card';
import { SelectControl } from './ui/Field';
import { TextLink } from './ui/Link';
import { EmptyState, Loading } from './ui/States';

/** Loaded on first visit, so the docs stay out of the trading bundle. */
const DocsPage = lazy(() =>
  import('./features/docs/DocsPage').then((module) => ({ default: module.DocsPage })),
);

type View =
  | { name: 'trader-dashboard' }
  /** `poolId` is the pool the trader asked for, where they named one. */
  | { name: 'trader-swap'; poolId?: string }
  | { name: 'trader-liquidity' }
  | { name: 'trader-onboarding' }
  | { name: typeof FAUCET_SECTION }
  | { name: 'operator-onboardings' }
  | { name: 'operator-onboarding'; onboardingId: string }
  | { name: 'operator-pools' }
  | { name: 'operator-settlement' }
  | { name: 'operator-proposal'; proposalId: string };

/** A view that has its own entry in the sidebar. Detail views do not. */
type Section = Exclude<View['name'], 'operator-onboarding' | 'operator-proposal'>;

type NavItem = { id: Section; label: string };

/**
 * Sections per role. Settlement and liquidity are the venue's alone: the demo
 * runs no queue, holds no LP and settles nothing, so it has no such screens to
 * offer.
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
    ...(simulated ? [] : [{ id: 'trader-liquidity' as const, label: 'Liquidity' }]),
    { id: 'trader-onboarding', label: 'Onboarding' },
    ...(simulated ? [] : [{ id: FAUCET_SECTION, label: 'Faucet' } as const]),
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
  [FAUCET_SECTION]: { name: FAUCET_SECTION },
  'trader-dashboard': { name: 'trader-dashboard' },
  'trader-swap': { name: 'trader-swap' },
  'trader-liquidity': { name: 'trader-liquidity' },
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
  const { docs, open: openDocs, leave: leaveDocs } = useDocsRoute();
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
    <div className="flex min-h-screen flex-col wide:h-screen wide:min-h-0">
      {/* Only the demo needs a standing warning: everything it shows is made
          up. In real mode the screens say what is simulated where it matters,
          on the documents and on the signer. */}
      {realLogin ? null : (
        <div className="border-primary-border text-foreground flex items-center justify-center gap-2 border-b bg-[linear-gradient(90deg,var(--primary-soft),color-mix(in_oklab,var(--info)_12%,var(--primary-soft)))] px-6 py-2 text-center text-[0.75rem]">
          <strong className="text-primary text-[0.6875rem] tracking-[0.04em] uppercase">
            Demo session
          </strong>
          <span className="text-muted-foreground">
            Simulated identities, signatures and ledger results
          </span>
        </div>
      )}

      <a
        className="bg-primary text-primary-foreground absolute top-0 -left-[9999px] z-[1100] rounded-br-md px-3.5 py-2 text-xs focus:left-0"
        href="#main"
        // Focus without the fragment, which would replace a docs link in the URL.
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('main')?.focus();
        }}
      >
        Skip to content
      </a>

      <div className="flex min-h-0 flex-1 flex-col wide:flex-row wide:items-stretch">
        {/* The docs are public, so they keep a sidebar before anyone signs in. */}
        {session.current || docs ? (
          <Sidebar
            items={session.current ? items : []}
            activeId={sectionOf(view)}
            onSelect={(id) => {
              leaveDocs();
              setView(sectionViews[id]);
            }}
            docs={{ active: docs, onSelect: openDocs }}
            footer={
              <SidebarFooter
                session={session}
                signedIn={signedIn}
                onSignIn={realLogin && !signedIn ? leaveDocs : undefined}
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

        <div className="flex min-w-0 flex-1 flex-col wide:overflow-y-auto">
          <main
            className={
              docs
                ? 'flex min-h-[40rem] flex-1 flex-col wide:min-h-0'
                : session.auth?.status === 'anonymous'
                  ? 'grid min-h-[100svh] place-items-center px-5 py-12'
                  : 'mx-auto w-full max-w-6xl flex-1 px-4 pt-6 pb-12 sm:px-7 sm:pt-9 sm:pb-16'
            }
            id="main"
            tabIndex={-1}
          >
            {/* Read-only and account-free, so no sign-in gate stands in front of it. */}
            {docs ? (
              <Suspense fallback={<Loading label="Loading docs" />}>
                <DocsPage />
              </Suspense>
            ) : (
              // Keyed on the actor, so one trader's data never lands on another's screen.
              <AppBody
                key={session.current?.accountId ?? 'anonymous'}
                session={session}
                view={view}
                navigate={setView}
                onOpenDocs={openDocs}
              />
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

function SidebarFooter({
  session,
  signedIn,
  onSignIn,
  onResetDemo,
  dark,
  onToggleTheme,
}: {
  session: Session;
  signedIn: boolean;
  /** Back to the sign-in screen, for a visitor reading the docs signed out. */
  onSignIn: (() => void) | undefined;
  onResetDemo: (() => void) | undefined;
  dark: boolean;
  onToggleTheme: () => void;
}) {
  // A real session shows who is signed in. Only the demo can act as someone else.
  const choosable = session.switchTo && session.identities && session.identities.length > 0;

  return (
    <>
      {choosable ? (
        <div className="flex min-w-0 flex-col gap-0.5">
          <SelectControl
            label="Demo identity"
            hideLabel
            controlClassName="h-8 text-xs"
            value={session.current?.accountId ?? ''}
            onValueChange={(next) => session.switchTo?.(next)}
            options={session.identities!.map((identity) => ({
              value: identity.accountId,
              label: `${identity.displayName} · ${roleLabels[identity.role]}`,
            }))}
          />
        </div>
      ) : session.current ? (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-xs font-medium">
            {/* The venue's own name for the caller, not a token claim. */}
            {session.current.displayName}
          </span>
          <span className="text-muted-foreground text-xs">{roleLabels[session.current.role]}</span>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        {session.logout && signedIn ? (
          <Button size="sm" variant="secondary" onClick={session.logout}>
            Sign out
          </Button>
        ) : null}
        {onSignIn ? (
          <Button size="sm" variant="secondary" onClick={onSignIn}>
            Sign in
          </Button>
        ) : null}
        {onResetDemo ? (
          <Button size="sm" variant="ghost" onClick={onResetDemo}>
            Reset demo data
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="text-muted-foreground hover:text-foreground size-8 flex-none"
          onClick={onToggleTheme}
          aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
        >
          {dark ? '☀' : '☾'}
        </Button>
      </div>
    </>
  );
}

function AppBody({
  session,
  view,
  navigate,
  onOpenDocs,
}: {
  session: Session;
  view: View;
  navigate: (next: View) => void;
  onOpenDocs: () => void;
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
      <section
        className="w-[min(100%,27rem)] animate-fade-in text-center"
        aria-labelledby="welcome-title"
      >
        <header className="mb-8 grid justify-items-center gap-3">
          <div className="border-primary-border mb-3 grid size-28 place-items-center rounded-[2rem] border bg-[linear-gradient(145deg,var(--card),var(--primary-soft))] shadow-[0_12px_44px_color-mix(in_oklab,var(--primary)_14%,transparent)] [&_img]:size-20">
            <Mark />
          </div>
          <h1 id="welcome-title" className="text-[clamp(2.25rem,7vw,2.75rem)] tracking-[-0.045em]">
            Canton DEX
          </h1>
        </header>
        <div className="bg-card rounded-3xl border p-[clamp(1.5rem,5vw,2.25rem)] shadow-float">
          <h2 className="mb-2.5 text-xl">Sign in to continue</h2>
          <p className="text-muted-foreground text-sm leading-[1.65]">
            Access your account, pools, swaps and liquidity.
          </p>
          <div className="mt-7 grid gap-3">
            <Button className="w-full" onClick={session.login}>
              Sign in <span aria-hidden="true">→</span>
            </Button>
            <Button className="w-full" variant="secondary" onClick={session.register}>
              Create an account
            </Button>
          </div>
        </div>
        <p className="text-muted-foreground mt-7 text-[0.75rem] tracking-[0.025em]">
          Built on Canton Network
        </p>
        <TextLink className="text-muted-foreground mt-3 text-[0.75rem]" onClick={onOpenDocs}>
          Developer docs
        </TextLink>
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
  const demo = useDemoApi();
  const goTrader = (target: NextStepTarget, poolId?: string) =>
    navigate(target === 'swap' ? { name: 'trader-swap', poolId } : { name: 'trader-onboarding' });

  switch (view.name) {
    case 'trader-dashboard':
      return <TraderDashboard onGo={goTrader} />;
    case 'trader-onboarding':
      return <TraderOnboarding />;
    case FAUCET_SECTION:
      return <Faucet />;
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
    case 'trader-liquidity':
      return <LiquidityDesk onGoToOnboarding={() => navigate({ name: 'trader-onboarding' })} />;
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
