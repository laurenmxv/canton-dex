import { useState } from 'react';
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
import { Badge, Callout } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card, CardHeader, DataList } from '../../ui/Card';
import { TextField } from '../../ui/Field';
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
    <div className="stack-lg fade-in">
      {queue.error && queue.data !== undefined ? (
        <RefreshFailure error={queue.error} onRetry={queue.reload} />
      ) : null}

      <PageHeader
        title={request.application.legalName}
        eyebrow="Onboarding request"
        back={{ label: 'All requests', onClick: onBack }}
        actions={
          <Badge tone={onboardingStatusTones[request.status]} dot={isWorking(request)}>
            {onboardingStatusLabels[request.status]}
          </Badge>
        }
      />

      <div className="grid-2">
        <Card>
          <CardHeader title="Submitted information" />
          <div className="card-pad">
            <DataList
              items={[
                { label: 'Legal name', value: request.application.legalName },
                { label: 'Country', value: request.application.countryCode },
                { label: 'Submitted', value: formatDateTime(request.createdAt) },
                { label: 'Reference', value: <span className="mono">{request.id}</span> },
                {
                  label: 'Documents',
                  value: <DocumentList application={request.application} />,
                },
              ]}
            />
          </div>
        </Card>

        <Card>
          <CardHeader title="Party" />
          <div className="card-pad stack-sm">
            {request.party ? (
              <>
                <DataList
                  items={[
                    {
                      label: 'Party',
                      value: <span className="mono">{shortParty(request.party.partyId)}</span>,
                    },
                    {
                      label: 'Mode',
                      value: <Badge tone="neutral">{partyModeLabels[request.partyMode]}</Badge>,
                    },
                    {
                      label: 'Registration',
                      value: (
                        <Badge
                          tone={partyStatusTones[request.party.status]}
                          dot={request.party.status === 'SUBMITTING'}
                        >
                          {partyStatusLabels[request.party.status]}
                        </Badge>
                      ),
                    },
                  ]}
                />
              </>
            ) : (
              <p className="muted text-xs">Not registered</p>
            )}
          </div>
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
          <CardHeader title="Onboarding progress" />
          <div className="card-pad">
            {simulated ? <SimulatedLedgerNotice /> : null}
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Step</th>
                <th>Command</th>
                <th>Contract</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody aria-live="polite">
              {request.ledgerSteps.map((step) => (
                <tr key={step.key}>
                  <td>{ledgerStepLabel(step.key, poolName)}</td>
                  <td className="mono muted">{step.commandId}</td>
                  <td className="mono muted">
                    {step.contractId ? shortContract(step.contractId) : '—'}
                  </td>
                  <td>
                    <Badge tone={ledgerStepTones[step.status]} dot={step.status === 'SUBMITTING'}>
                      {step.status}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
            <Badge tone={rejected ? 'danger' : 'success'}>
              {rejected ? 'Rejected' : 'Approved'}
            </Badge>
          }
        />
        <div className="card-pad stack">
          {rejected || onboarding.partyMode !== 'external' ? null : (
            <Callout tone="info" title="Accepted">
              {acceptedDetail(onboarding.party)}
            </Callout>
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
        </div>
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
      <div className="card-pad stack">
        {poolsError ? (
          <Callout tone="warning" title="Could not load pools">
            {poolsError.message}{' '}
            <button type="button" className="table-link" onClick={onRetryPools}>
              Try again
            </button>
          </Callout>
        ) : pools === undefined ? (
          <p className="muted text-xs">Loading pools…</p>
        ) : pools.length === 0 ? (
          <Callout tone="warning" title="No pools exist yet">
            Create a pool before approving, otherwise there is nothing to permit.
          </Callout>
        ) : (
          <fieldset className="stack-sm">
            <legend className="field-label" style={{ marginBottom: '0.5rem' }}>
              Permitted pools
            </legend>
            {pools.map((pool) => (
              <label key={pool.poolId} className="row text-sm">
                <input
                  type="checkbox"
                  checked={selected.includes(pool.poolId)}
                  onChange={() => toggle(pool.poolId)}
                />
                <span>{pool.name}</span>
              </label>
            ))}
            {touched && selected.length === 0 ? (
              <p className="field-error">Select at least one pool</p>
            ) : null}
          </fieldset>
        )}

        <TextField
          label="Party name"
          error={
            touched && !hintValid
              ? 'Use lowercase letters, digits and underscores, starting with a letter'
              : undefined
          }
          value={hint}
          maxLength={64}
          onChange={(event) => setHint(event.target.value)}
        />

        {review.error ? <Callout tone="danger">{review.error.message}</Callout> : null}

        {confirmingReject ? (
          <Callout tone="danger" title="Reject this application?">
            <p>Rejection is final.</p>
            <div className="row" style={{ marginTop: '0.75rem' }}>
              <Button variant="danger" loading={review.pending} onClick={() => decide('REJECTED')}>
                Yes, reject
              </Button>
              <Button variant="ghost" onClick={() => setConfirmingReject(false)}>
                Keep reviewing
              </Button>
            </div>
          </Callout>
        ) : (
          <div className="row">
            <Button loading={review.pending} onClick={() => decide('APPROVED')}>
              Accept with {selected.length} pool{selected.length === 1 ? '' : 's'}
            </Button>
            <Button variant="danger" onClick={() => setConfirmingReject(true)}>
              Reject
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
