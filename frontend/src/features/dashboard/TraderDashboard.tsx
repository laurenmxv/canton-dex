import { LoadingButton as Button } from '@openzeppelin/ui-components';
import { useDemoApi, useDexClient } from '../../app/runtime';
import { useAsync } from '../../app/useAsync';
import type { Onboarding } from '../../lib/api/types';
import { onboardingStatusLabels, onboardingStatusTones, shortParty } from '../../lib/labels';
import { Mono } from '../../ui/Mono';
import { StatusBadge } from '../../ui/Badge';
import { Card, CardHeader } from '../../ui/Card';
import { PageHeader } from '../../ui/PageHeader';
import { AsyncSection, EmptyState, ErrorState, RefreshFailure } from '../../ui/States';
import { NoticeBoard } from '../../ui/NoticeBoard';
import { useOnboardingNotices } from '../onboarding/notices';
import { confirmedPoolIds, isSettling, isWorking } from '../onboarding/progress';
import { AttestationReceipt } from './AttestationReceipt';
import { Holdings } from './Holdings';
import { nextStep, type NextStepTarget } from './nextStep';
import { PoolAccess } from './PoolAccess';
import { SwapRequestsCard } from './SwapRequestsCard';

/**
 * The trader's first screen: where the onboarding stands, which pools the
 * ledger has opened to them, and what they hold.
 *
 * Nothing on it is priced or totalled. The venue reports no price for an
 * instrument, so a portfolio value would be this screen's invention.
 */
export function TraderDashboard({
  onGo,
}: {
  /** The pool is the one the trader picked, where they picked one. */
  onGo: (target: NextStepTarget, poolId?: string) => void;
}) {
  const client = useDexClient();
  const demo = useDemoApi();
  const onboarding = useAsync((signal) => client.onboarding.mine({ signal }), [client], {
    pollWhile: isSettling,
  });
  const catalogue = useAsync((signal) => client.pools.list({ signal }), [client]);

  const open = confirmedPoolIds(onboarding.data);
  const updates = useOnboardingNotices(onboarding.data);
  const party = onboarding.data?.party?.partyId;

  return (
    <div className="flex flex-col gap-6 fade-in">
      <PageHeader
        title="Dashboard"
        description={
          party ? (
            <>
              Trading as <Mono>{shortParty(party)}</Mono>
            </>
          ) : undefined
        }
      />

      <NoticeBoard notices={updates.notices} onDismiss={updates.dismiss} />

      {onboarding.error && onboarding.data !== undefined ? (
        <RefreshFailure error={onboarding.error} onRetry={onboarding.reload} />
      ) : null}

      {onboarding.error && onboarding.data === undefined ? (
        <Card>
          <ErrorState error={onboarding.error} onRetry={onboarding.reload} />
        </Card>
      ) : (
        <StatusStrip
          onboarding={onboarding.data}
          loading={onboarding.loading}
          eligible={onboarding.data === undefined ? undefined : open.length}
          onGo={onGo}
        />
      )}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(19rem,1fr))] items-start gap-4">
        <Card>
          <CardHeader
            title="Pools open to you"
            actions={open.length > 0 ? <StatusBadge tone="neutral" label={String(open.length)} /> : null}
          />
          <AsyncSection
            result={catalogue}
            label="Loading the pool catalogue"
            rows={2}
            empty={<EmptyState title="No pools yet" />}
          >
            {(pools) => (
              <PoolAccess
                poolIds={open}
                catalogue={pools}
                onTrade={(poolId) => onGo('swap', poolId)}
              />
            )}
          </AsyncSection>
        </Card>

        {/* The venue reads holdings from the ledger. The demo settles nothing
            and holds nothing, so it has none to report. */}
        {demo ? <SwapRequestsCard demo={demo} /> : <Holdings />}
      </div>

      <AttestationReceipt
        onboarding={onboarding.data ?? null}
        pools={catalogue.data ?? []}
        simulated={demo !== null}
      />
    </div>
  );
}

/**
 * The state the venue reports, and the one thing to do about it.
 *
 * It states a condition rather than opening a subject, so it is a strip and
 * not a card: a reader takes the action or reads past it in one glance.
 */
function StatusStrip({
  onboarding,
  loading,
  eligible,
  onGo,
}: {
  onboarding: Onboarding | null | undefined;
  loading: boolean;
  eligible: number | undefined;
  onGo: (target: NextStepTarget) => void;
}) {
  if (loading && onboarding === undefined) {
    return <div className="bg-muted animate-pulse rounded-sm" style={{ height: '5rem', borderRadius: 'var(--radius-lg)' }} />;
  }

  const step = nextStep(onboarding ?? null, eligible);
  return (
    <div className="border-primary-border shadow-card flex flex-wrap items-center gap-4 rounded-lg border bg-[linear-gradient(120deg,var(--primary-soft)_0%,var(--card)_62%)] px-5 py-4">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="font-semibold">{step.headline}</p>
        {step.detail ? <p className="text-muted-foreground text-xs">{step.detail}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2.5">
        {onboarding ? (
          <StatusBadge tone={onboardingStatusTones[onboarding.status]} dot={isWorking(onboarding)} label={onboardingStatusLabels[onboarding.status]} />
        ) : (
          <StatusBadge tone="neutral" label="Not started" />
        )}
        {step.action ? (
          <Button
            variant={step.primary ? 'default' : 'secondary'}
            onClick={() => onGo(step.action!.target)}
          >
            {step.action.label}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
