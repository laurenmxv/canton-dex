import { useState } from 'react';
import { useDemoControls, requireDemoApi } from '../../app/runtime';
import { useAction, useAsync } from '../../app/useAsync';
import type { PoolApprover } from '../../lib/api/types';
import {
  approverLabels,
  formatAmount,
  formatDateTime,
  proposalStatusLabels,
  proposalStatusTones,
  shortParty,
  symbolOf,
} from '../../lib/labels';
import { Badge, Callout } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card, CardHeader, DataList } from '../../ui/Card';
import { ErrorState, Loading } from '../../ui/States';
import { PageHeader } from '../../ui/PageHeader';
import { approvalCount } from './approvals';

export function ProposalDetail({
  proposalId,
  onBack,
}: {
  proposalId: string;
  onBack: () => void;
}) {
  const demo = requireDemoApi();
  const controls = useDemoControls();
  const proposal = useAsync(() => demo.pools.getProposal(proposalId), [demo, proposalId]);
  const instruments = useAsync(() => demo.pools.listInstruments(), [demo]);

  const [approving, setApproving] = useState<PoolApprover>();
  const approve = useAction(async (approver: PoolApprover) => {
    if (!controls) throw new Error('Counterparty approvals are simulated only in the demo');
    setApproving(approver);
    try {
      return await controls.approveAsCounterparty(proposalId, approver);
    } finally {
      setApproving(undefined);
    }
  });
  const finalize = useAction(() => demo.pools.requestCreation(proposalId));

  if (proposal.loading) return <Loading label="Loading proposal" />;
  if (proposal.error) return <ErrorState error={proposal.error} onRetry={proposal.reload} />;
  if (!proposal.data) return null;

  const data = proposal.data;
  const { approved, required } = approvalCount(data);
  const ready = approved === required;
  const created = data.status === 'CREATED';
  const symbol = (instrumentId: string) => symbolOf(instruments.data ?? [], instrumentId);

  return (
    <div className="stack-lg fade-in">
      <PageHeader
        title={data.name}
        eyebrow="Pool proposal"
        back={{ label: 'All pools', onClick: onBack }}
        actions={
          <Badge tone={proposalStatusTones[data.status]}>
            {proposalStatusLabels[data.status]}
          </Badge>
        }
      />

      <div className="grid-2">
        <Card>
          <CardHeader title="Settings" />
          <div className="card-pad">
            <DataList
              items={[
                { label: 'Base', value: symbol(data.settings.baseInstrumentId) },
                { label: 'Quote', value: symbol(data.settings.quoteInstrumentId) },
                { label: 'Fee', value: <span className="tabular">{data.settings.feeBps} bps</span> },
                {
                  label: 'Base reserve',
                  value: <span className="tabular">{formatAmount(data.settings.baseReserve)}</span>,
                },
                {
                  label: 'Quote reserve',
                  value: <span className="tabular">{formatAmount(data.settings.quoteReserve)}</span>,
                },
                {
                  label: 'LP supply',
                  value: (
                    <span className="tabular">{formatAmount(data.settings.lpTokenSupply)}</span>
                  ),
                },
                { label: 'Proposed', value: formatDateTime(data.createdAt) },
              ]}
            />
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Required approvals"
            description={`${approved} of ${required} collected`}
          />
          <div className="card-pad stack">
            <Callout tone="demo">Approvals are fixtures</Callout>
            <ul className="stack-sm">
              {data.approvals.map((approval) => (
                <li key={approval.approver} className="row-between">
                  <div>
                    <div className="text-sm">{approverLabels[approval.approver]}</div>
                    <div className="mono muted" style={{ fontSize: '0.75rem' }}>
                      {shortParty(approval.party)}
                    </div>
                  </div>
                  {approval.approved ? (
                    <Badge tone="success">Approved</Badge>
                  ) : controls ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={approving === approval.approver}
                      disabled={created}
                      onClick={async () => {
                        if (await approve.perform(approval.approver)) proposal.reload();
                      }}
                    >
                      Simulate approval
                    </Button>
                  ) : (
                    <Badge tone="neutral">Pending</Badge>
                  )}
                </li>
              ))}
            </ul>
            {approve.error ? <Callout tone="danger">{approve.error.message}</Callout> : null}
          </div>
        </Card>
      </div>

      <Card padded>
        {created ? (
          <div className="stack-sm">
            <div className="row">
              <Badge tone="success">Pool created</Badge>
            </div>
            <DataList
              items={[
                {
                  label: 'Pool identifier',
                  value: <span className="mono">{data.poolId}</span>,
                },
              ]}
            />
            <p className="muted text-xs">
              Traders approved for this pool can now request swaps against it.
            </p>
          </div>
        ) : (
          <div className="row-between">
            <div>
              <h2 className="card-title">Request pool creation</h2>
              <p className="card-desc">
                {ready
                  ? 'Every required approval is present.'
                  : `Blocked until all ${required} approvals are present. ${
                      required - approved
                    } still missing.`}
              </p>
            </div>
            <Button
              disabled={!ready}
              loading={finalize.pending}
              onClick={async () => {
                if (await finalize.perform()) proposal.reload();
              }}
            >
              Request pool creation
            </Button>
          </div>
        )}
        {finalize.error ? (
          <div style={{ marginTop: '0.75rem' }}>
            <Callout tone="danger">{finalize.error.message}</Callout>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
