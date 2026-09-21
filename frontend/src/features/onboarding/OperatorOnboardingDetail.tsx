import {
  Banner,
  CardContent,
  Checkbox,
  DataTable,
  Label,
  LoadingButton as Button,
} from '@openzeppelin/ui-components';
import { useId, useState } from 'react';
import { useDemoApi, useDexClient } from '../../app/runtime';
import { useAction, useAsync } from '../../app/useAsync';
import type { Onboarding, PartyPreparation, PoolSummary } from '../../lib/api/types';
import { PARTY_HINT_PATTERN } from '../../lib/api/types';
import {
  formatDateTime,
  ledgerStepLabel,
  ledgerStepTones,
  onboardingStatusLabels,
  onboardingStatusTones,
  partyModeLabels,
  partyStatusLabels,
  partyStatusTones,
  poolNameOf,
  shortContract,
  shortParty,
} from '../../lib/labels';
import { Mono } from '../../ui/Mono';
import { TextLink } from '../../ui/Link';
import { StatusBadge } from '../../ui/Badge';
import { Card, CardHeader, DataList } from '../../ui/Card';
import { TextControl } from '../../ui/Field';
import { SimulatedLedgerNotice } from '../../ui/SimulatedLedger';
import { EmptyState, ErrorState, Loading, RefreshFailure } from '../../ui/States';
import { PageHeader } from '../../ui/PageHeader';
import { DocumentList } from './DocumentList';
import { isSettling, isWorking } from './progress';

export function OperatorOnboardingDetail({
  onboardingId,
  onBack,
}: {
  onboardingId: string;
  onBack: () => void;
}) {
  const ledgerStepsTitle = useId();
  const client = useDexClient();
  // Only the demo produces its own identifiers; the venue's are real.
  const simulated = useDemoApi() !== null;
  // The queue already carries every field this screen shows, and the backend
  // serves no operator read of a single request, so this screen reads the queue
  // and finds its own record.
  const queue = useAsync((signal) => client.admin.listOnboardings({ signal }), [client, onboardingId], {
    pollWhile: (list) => list.some((item) => item.id === onboardingId && isSettling(item)),
  });
  const pools = useAsync((signal) => client.pools.list({ signal }), [client]);
  const request = queue.data?.find((item) => item.id === onboardingId);

  // Only the first load takes the screen away; a reload after a review keeps it.
  if (queue.loading && !queue.data) return <Loading label="Loading request" />;
  if (queue.error && !queue.data) {
    return <ErrorState error={queue.error} onRetry={queue.reload} />;
  }
  if (!request) {
    return (
      <EmptyState
        icon="?"
        title="That request is not in the queue"
        action={
          <Button variant="secondary" onClick={onBack}>
            All requests
          </Button>
        }
      />
    );
  }
  const poolName = (poolId: string) => poolNameOf(pools.data ?? [], poolId);

  return (
    <div className="flex flex-col gap-6 fade-in">
      {queue.error && queue.data !== undefined ? (
        <RefreshFailure error={queue.error} onRetry={queue.reload} />
      ) : null}

      <PageHeader
        title={request.application.legalName}
        eyebrow="Onboarding request"
        back={{ label: 'All requests', onClick: onBack }}
        actions={
          <StatusBadge tone={onboardingStatusTones[request.status]} dot={isWorking(request)} label={onboardingStatusLabels[request.status]} />
        }
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardHeader title="Submitted information" />
          <CardContent className="p-5">
            <DataList
              items={[
                { label: 'Legal name', value: request.application.legalName },
                { label: 'Country', value: request.application.countryCode },
                { label: 'Submitted', value: formatDateTime(request.createdAt) },
                { label: 'Reference', value: <Mono>{request.id}</Mono> },
                {
                  label: 'Documents',
                  value: <DocumentList application={request.application} />,
                },
              ]}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="Party" />
          <CardContent className="p-5 flex flex-col gap-2">
            {request.party ? (
              <>
                <DataList
                  items={[
                    {
                      label: 'Party',
                      value: <Mono>{shortParty(request.party.partyId)}</Mono>,
                    },
                    {
                      label: 'Mode',
                      value: <StatusBadge tone="neutral" label={partyModeLabels[request.partyMode]} />,
                    },
                    {
                      label: 'Registration',
                      value: (
                        <StatusBadge
                          tone={partyStatusTones[request.party.status]}
                          dot={request.party.status === 'SUBMITTING'} label={partyStatusLabels[request.party.status]} />
                      ),
                    },
                  ]}
                />
              </>
            ) : (
              <p className="text-muted-foreground text-xs">Not registered</p>
            )}
          </CardContent>
        </Card>
      </div>

      <ReviewPanel
        key={request.id}
        onboarding={request}
        pools={pools.data}
        poolsError={pools.error}
        onRetryPools={pools.reload}
        onReviewed={queue.reload}
      />

      {request.ledgerSteps.length > 0 ? (
        <Card>
          <CardHeader title="Onboarding progress" titleId={ledgerStepsTitle} />
          <CardContent className="p-5">
            {simulated ? <SimulatedLedgerNotice /> : null}
          </CardContent>
          {/*
            The steps land one at a time while the operator watches. The kit
            table owns its own `tbody`, so the live region sits on the element
            around it; a change inside it is announced all the same.
          */}
          <div aria-live="polite">
            <DataTable
              aria-labelledby={ledgerStepsTitle}
              columns={[
                {
                  id: 'step',
                  header: 'Step',
                  cell: (step) => ledgerStepLabel(step.key, poolName),
                },
                {
                  id: 'command',
                  header: 'Command',
                  cellClassName: 'font-mono text-xs text-muted-foreground',
                  cell: (step) => step.commandId,
                },
                {
                  id: 'contract',
                  header: 'Contract',
                  cellClassName: 'font-mono text-xs text-muted-foreground',
                  cell: (step) => (step.contractId ? shortContract(step.contractId) : '—'),
                },
                {
                  id: 'status',
                  header: 'Status',
                  cell: (step) => (
                    <StatusBadge
                      tone={ledgerStepTones[step.status]}
                      dot={step.status === 'SUBMITTING'}
                      label={step.status}
                    />
                  ),
                },
              ]}
              rows={request.ledgerSteps}
              getRowKey={(step) => step.key}
              className="border-0"
            />
          </div>
        </Card>
      ) : null}
    </div>
  );
}

/** Where the trader's own party stands, in the same words the badges use. */
function acceptedDetail(party: PartyPreparation | null): string {
  if (party?.confirmed || party?.status === 'CONFIRMED') {
    return `Party registered · ${party.partyId}`;
  }
  return party ? partyStatusLabels[party.status] : 'Not registered';
}

function ReviewPanel({
  onboarding,
  pools,
  poolsError,
  onRetryPools,
  onReviewed,
}: {
  onboarding: Onboarding;
  pools: PoolSummary[] | undefined;
  poolsError: Error | undefined;
  onRetryPools: () => void;
  onReviewed: () => void;
}) {
  const client = useDexClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [hint, setHint] = useState(onboarding.suggestedPartyHint);
  const [confirmingReject, setConfirmingReject] = useState(false);
  const [touched, setTouched] = useState(false);
  const review = useAction((decision: 'APPROVED' | 'REJECTED') =>
    client.admin.reviewOnboarding(onboarding.id, {
      decision,
      approvedPoolIds: decision === 'APPROVED' ? selected : [],
      partyHint: decision === 'APPROVED' ? hint.trim() : null,
    }),
  );
  const hintValid = PARTY_HINT_PATTERN.test(hint.trim());

  if (onboarding.review) {
    const rejected = onboarding.review.decision === 'REJECTED';
    return (
      <Card>
        <CardHeader
          title="Review"
          actions={
            <StatusBadge tone={rejected ? 'danger' : 'success'} label={rejected ? 'Rejected' : 'Approved'} />
          }
        />
        <CardContent className="p-5 flex flex-col gap-4">
          {rejected || onboarding.partyMode !== 'external' ? null : (
            <Banner variant="info" title="Accepted" size="compact" dismissible={false}>
              {acceptedDetail(onboarding.party)}
            </Banner>
          )}
          <DataList
            items={[
              { label: 'Decided', value: formatDateTime(onboarding.review.reviewedAt) },
              {
                label: 'Permitted pools',
                value: rejected
                  ? 'None'
                  : onboarding.review.approvedPoolIds
                      .map((poolId) => poolNameOf(pools ?? [], poolId))
                      .join(', '),
              },
              {
                label: 'Party name',
                value: onboarding.review.partyHint ?? 'None',
              },
            ]}
          />
        </CardContent>
      </Card>
    );
  }

  const toggle = (poolId: string) =>
    setSelected((current) =>
      current.includes(poolId)
        ? current.filter((candidate) => candidate !== poolId)
        : [...current, poolId],
    );

  async function decide(decision: 'APPROVED' | 'REJECTED') {
    setTouched(true);
    if (decision === 'APPROVED' && (selected.length === 0 || !hintValid)) return;
    if (await review.perform(decision)) onReviewed();
  }

  return (
    <Card>
      <CardHeader
        title="Review this application"
      />
      <CardContent className="p-5 flex flex-col gap-4">
        {poolsError ? (
          <Banner variant="warning" title="Could not load pools" size="compact" dismissible={false}>
            {poolsError.message}{' '}
            <TextLink onClick={onRetryPools}>Try again</TextLink>
          </Banner>
        ) : pools === undefined ? (
          <p className="text-muted-foreground text-xs">Loading pools…</p>
        ) : pools.length === 0 ? (
          <Banner variant="warning" title="No pools exist yet" size="compact" dismissible={false}>
            Create a pool before approving, otherwise there is nothing to permit.
          </Banner>
        ) : (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-xs font-medium" style={{ marginBottom: '0.5rem' }}>
              Permitted pools
            </legend>
            {pools.map((pool) => (
              <Label key={pool.poolId} className="flex items-center gap-3 text-sm">
                <Checkbox
                  checked={selected.includes(pool.poolId)}
                  onCheckedChange={() => toggle(pool.poolId)}
                />
                <span>{pool.name}</span>
              </Label>
            ))}
            {touched && selected.length === 0 ? (
              <p className="text-destructive text-[0.75rem]">Select at least one pool</p>
            ) : null}
          </fieldset>
        )}

        <TextControl
          label="Party name"
          error={
            touched && !hintValid
              ? 'Start with dex_, followed by a name using lowercase letters, digits and underscores'
              : undefined
          }
          value={hint}
          maxLength={64}
          onChange={(event) => setHint(event.target.value)}
        />

        {review.error ? <Banner variant="error" size="compact" dismissible={false}>{review.error.message}</Banner> : null}

        {confirmingReject ? (
          <Banner variant="error" title="Reject this application?" size="compact" dismissible={false}>
            <p>Rejection is final.</p>
            <div className="flex items-center gap-3" style={{ marginTop: '0.75rem' }}>
              <Button variant="destructive" loading={review.pending} onClick={() => decide('REJECTED')}>
                Yes, reject
              </Button>
              <Button variant="ghost" onClick={() => setConfirmingReject(false)}>
                Keep reviewing
              </Button>
            </div>
          </Banner>
        ) : (
          <div className="flex items-center gap-3">
            <Button loading={review.pending} onClick={() => decide('APPROVED')}>
              Accept with {selected.length} pool{selected.length === 1 ? '' : 's'}
            </Button>
            <Button variant="destructive" onClick={() => setConfirmingReject(true)}>
              Reject
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
