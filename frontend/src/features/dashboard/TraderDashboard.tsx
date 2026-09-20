import { useDemoApi, useDexClient } from '../../app/runtime';
import { useAsync } from '../../app/useAsync';
import type { Onboarding, PoolSummary } from '../../lib/api/types';
import {
  onboardingStatusLabels,
  onboardingStatusTones,
  poolNameOf,
} from '../../lib/labels';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { AsyncSection, EmptyState, ErrorState, RefreshFailure } from '../../ui/States';
import { NoticeBoard } from '../../ui/NoticeBoard';
import { useOnboardingNotices } from '../onboarding/notices';
import { confirmedPoolIds, isSettling, isWorking } from '../onboarding/progress';
import { AttestationReceipt } from './AttestationReceipt';
import { nextStep, type NextStepTarget } from './nextStep';
import { SwapRequestsCard } from './SwapRequestsCard';

/**
 * The trader's first screen: where the onboarding stands, which pools are open,
 * and what has been requested. No balance and no portfolio, because the venue
 * reports neither.
 */
export function TraderDashboard({ onGo }: { onGo: (target: NextStepTarget) => void }) {
  const client = useDexClient();
  const demo = useDemoApi();
  const onboarding = useAsync((signal) => client.onboarding.mine({ signal }), [client], {
    pollWhile: isSettling,
  });
  const catalogue = useAsync((signal) => client.pools.list({ signal }), [client]);

  const open = confirmedPoolIds(onboarding.data);
  const updates = useOnboardingNotices(onboarding.data);

  return (
    <div className="stack-lg fade-in">
      <header className="page-head">
        <h1 className="page-title">Dashboard</h1>
      </header>

      <NoticeBoard notices={updates.notices} onDismiss={updates.dismiss} />

      {onboarding.error && onboarding.data !== undefined ? (
        <RefreshFailure error={onboarding.error} onRetry={onboarding.reload} />
      ) : null}

      {onboarding.error && onboarding.data === undefined ? (
        <Card>
          <CardHeader title="Your next step" />
          <ErrorState error={onboarding.error} onRetry={onboarding.reload} />
        </Card>
      ) : (
        <NextStepCard
          onboarding={onboarding.data}
          loading={onboarding.loading}
          eligible={onboarding.data === undefined ? undefined : open.length}
          onGo={onGo}
        />
      )}

      <AttestationReceipt
        onboarding={onboarding.data ?? null}
        pools={catalogue.data ?? []}
        simulated={demo !== null}
      />

      <div className={demo ? 'grid-2' : undefined}>
        <Card>
          <CardHeader title="Pools open to you" />
          <AsyncSection
            result={catalogue}
            label="Loading the pool catalogue"
            rows={2}
            empty={<EmptyState title="No pools yet" />}
          >
            {(pools) => <OpenPools poolIds={open} catalogue={pools} />}
          </AsyncSection>
        </Card>

        {demo ? <SwapRequestsCard demo={demo} /> : null}
      </div>
    </div>
  );
}

function OpenPools({ poolIds, catalogue }: { poolIds: string[]; catalogue: PoolSummary[] }) {
  if (poolIds.length === 0) {
    return <EmptyState title="No pools yet" />;
  }
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Pair</th>
        </tr>
      </thead>
      <tbody>
        {poolIds.map((poolId) => (
          <tr key={poolId}>
            <td>{poolNameOf(catalogue, poolId)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function NextStepCard({
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
    return (
      <Card>
        <CardHeader title="Your next step" />
        <div className="card-pad">
          <div className="skeleton" style={{ height: '3rem' }} />
        </div>
      </Card>
    );
  }

  const step = nextStep(onboarding ?? null, eligible);
  return (
    <Card>
      <CardHeader
        title="Your next step"
        actions={
          onboarding ? (
            <Badge tone={onboardingStatusTones[onboarding.status]} dot={isWorking(onboarding)}>
              {onboardingStatusLabels[onboarding.status]}
            </Badge>
          ) : (
            <Badge tone="neutral">Not started</Badge>
          )
        }
      />
      <div className="card-pad">
        <div className="row-between next-step">
          <div>
            <h2 className="card-title">{step.headline}</h2>
            {step.detail ? <p className="card-desc">{step.detail}</p> : null}
          </div>
          {step.action ? (
            <Button
              variant={step.primary ? 'primary' : 'secondary'}
              onClick={() => onGo(step.action!.target)}
            >
              {step.action.label}
            </Button>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
