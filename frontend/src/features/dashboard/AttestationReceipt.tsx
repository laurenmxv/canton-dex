import type { Onboarding, PoolSummary } from '../../lib/api/types';
import { poolNameOf, shortContract } from '../../lib/labels';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@openzeppelin/ui-components';
import { Mono } from '../../ui/Mono';
import { StatusBadge } from '../../ui/Badge';
import { Card, CardHeader, DataList } from '../../ui/Card';
import { CopyField } from '../../ui/CopyField';
import { SimulatedLedgerNotice } from '../../ui/SimulatedLedger';
import { confirmedAttestation, confirmedPoolIds } from '../onboarding/progress';

/**
 * Proof that the venue attested this trader.
 *
 * It appears as soon as the attestation confirms, even while a pool access
 * step is still working, and it never implies access: the pools it lists as
 * confirmed are the only ones the ledger has granted.
 *
 * The proof is evidence, not a step to take, so the card opens folded: the
 * confirmation and the contract it rests on stay in view, and every
 * identifier is one disclosure away.
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
      <CardHeader title="KYC attestation" actions={<StatusBadge tone="success" label="Confirmed" />} />
      <Accordion type="single" collapsible variant="card">
        <AccordionItem value="proof" className="border-b-0">
          {/*
            The summary names the contract, so a reader can tell one receipt
            from another without opening it.
          */}
          <AccordionTrigger className="bg-surface text-muted-foreground mx-5 mt-3 rounded-md border px-3.5 py-3 text-xs">
            <span className="flex flex-1 flex-wrap items-baseline justify-between gap-2 pr-2">
              <span>Proof and details</span>
              <span className="font-mono">{shortContract(attestation.contractId)}</span>
            </span>
          </AccordionTrigger>
          <AccordionContent>
            <div className="flex flex-col gap-4 p-5">
          {simulated ? <SimulatedLedgerNotice /> : null}
          <CopyField label="Contract ID" value={attestation.contractId} />
          <DataList
            items={[
              {
                label: 'Issued by',
                value: <Mono>{attestation.issuer ?? 'Unknown'}</Mono>,
              },
              {
                label: 'Your party',
                value: <Mono>{onboarding.party?.partyId ?? 'Unknown'}</Mono>,
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
              ...(attestation.updateId
                ? [
                    {
                      label: 'Ledger update',
                      value: <Mono>{attestation.updateId}</Mono>,
                    },
                  ]
                : []),
            ]}
              />
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </Card>
  );
}
