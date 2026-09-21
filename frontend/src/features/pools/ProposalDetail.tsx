import {
  Banner,
  CardContent,
  LoadingButton as Button,
} from '@openzeppelin/ui-components';
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
import { Mono } from '../../ui/Mono';
import { StatusBadge } from '../../ui/Badge';
import { Card, CardHeader, DataList } from '../../ui/Card';
import { ErrorState, Loading } from '../../ui/States';
import { Note } from '../../ui/Note';
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
    <div className="flex flex-col gap-6 fade-in">
      <PageHeader
        title={data.name}
        eyebrow="Pool proposal"
        back={{ label: 'All pools', onClick: onBack }}
        actions={
          <StatusBadge tone={proposalStatusTones[data.status]} label={proposalStatusLabels[data.status]} />
        }
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardHeader title="Settings" />
          <CardContent className="p-5">
            <DataList
              items={[
                { label: 'Base', value: symbol(data.settings.baseInstrumentId) },
                { label: 'Quote', value: symbol(data.settings.quoteInstrumentId) },
                { label: 'Fee', value: <span className="tabular-nums">{data.settings.feeBps} bps</span> },
                {
                  label: 'Base reserve',
                  value: <span className="tabular-nums">{formatAmount(data.settings.baseReserve)}</span>,
                },
                {
                  label: 'Quote reserve',
                  value: <span className="tabular-nums">{formatAmount(data.settings.quoteReserve)}</span>,
                },
                {
                  label: 'LP supply',
                  value: (
                    <span className="tabular-nums">{formatAmount(data.settings.lpTokenSupply)}</span>
                  ),
                },
                { label: 'Proposed', value: formatDateTime(data.createdAt) },
              ]}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader
            title="Required approvals"
            description={`${approved} of ${required} collected`}
          />
          <CardContent className="p-5 flex flex-col gap-4">
            <Note tone="demo">Approvals are fixtures</Note>
            <ul className="flex flex-col gap-2">
              {data.approvals.map((approval) => (
                <li key={approval.approver} className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm">{approverLabels[approval.approver]}</div>
                    <div className="font-mono text-xs text-muted-foreground" style={{ fontSize: '0.75rem' }}>
                      {shortParty(approval.party)}
                    </div>
                  </div>
                  {approval.approved ? (
                    <StatusBadge tone="success" label="Approved" />
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
                    <StatusBadge tone="neutral" label="Pending" />
                  )}
                </li>
              ))}
            </ul>
            {approve.error ? <Banner variant="error" size="compact" dismissible={false}>{approve.error.message}</Banner> : null}
          </CardContent>
        </Card>
      </div>

      <Card padded>
        {created ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-3">
              <StatusBadge tone="success" label="Pool created" />
            </div>
            <DataList
              items={[
                {
                  label: 'Pool identifier',
                  value: <Mono>{data.poolId}</Mono>,
                },
              ]}
            />
            <p className="text-muted-foreground text-xs">
              Traders approved for this pool can now request swaps against it.
            </p>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-[0.9375rem] font-semibold tracking-[-0.01em]">Request pool creation</h2>
              <p className="text-muted-foreground mt-0.5 text-xs">
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
            <Banner variant="error" size="compact" dismissible={false}>{finalize.error.message}</Banner>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
