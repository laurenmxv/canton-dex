import type { Onboarding, PoolSummary } from '../../lib/api/types';
import { poolNameOf } from '../../lib/labels';
import { Badge } from '../../ui/Badge';
import { Card, CardHeader, DataList } from '../../ui/Card';
import { CopyField } from '../../ui/CopyField';
import { Disclosure } from '../../ui/Disclosure';
import { SimulatedLedgerNotice } from '../../ui/SimulatedLedger';
import { confirmedAttestation, confirmedPoolIds } from '../onboarding/progress';

/**
 * Proof that the venue attested this trader.
 *
 * It appears as soon as the attestation confirms, even while a pool access step
 * is still working, and it never implies access: the pools it lists as
 * confirmed are the only ones the ledger has granted.
 */
export function AttestationReceipt({
  onboarding,
  pools,
  simulated = false,
}: {
  onboarding: Onboarding | null;
  pools: PoolSummary[];
  /** True where the demo produced these identifiers rather than a ledger. */
  simulated?: boolean;
}) {
  const attestation = confirmedAttestation(onboarding);
  if (!onboarding || !attestation || attestation.contractId === null) return null;

  const approved = onboarding.review?.approvedPoolIds ?? [];
  const granted = confirmedPoolIds(onboarding);
  const unresolved = onboarding.ledgerSteps.some((step) => step.status === 'UNRESOLVED');
  return (
    <Card>
      <CardHeader
        title="KYC attestation"
        actions={<Badge tone="success">Confirmed</Badge>}
      />
      <div className="card-pad stack">
        {simulated ? <SimulatedLedgerNotice /> : null}
        <CopyField label="Contract ID" value={attestation.contractId} />
        <DataList
          items={[
            {
              label: 'Issued by',
              value: <span className="mono">{attestation.issuer ?? 'Unknown'}</span>,
            },
            {
              label: 'Your party',
              value: <span className="mono">{onboarding.party?.partyId ?? 'Unknown'}</span>,
            },
            {
              label: 'Pools approved',
              value:
                approved.length === 0
                  ? 'None'
                  : approved.map((poolId) => poolNameOf(pools, poolId)).join(', '),
            },
            {
              label: 'Access confirmed',
              value: granted.length > 0
                ? granted.map((poolId) => poolNameOf(pools, poolId)).join(', ')
                : unresolved
                  ? 'Checking confirmation'
                  : 'Awaiting confirmation',
            },
          ]}
        />
        {attestation.updateId ? (
          <Disclosure summary="Details">
            <DataList
              items={[
                {
                  label: 'Ledger update',
                  value: <span className="mono">{attestation.updateId}</span>,
                },
              ]}
            />
          </Disclosure>
        ) : null}
      </div>
    </Card>
  );
}
