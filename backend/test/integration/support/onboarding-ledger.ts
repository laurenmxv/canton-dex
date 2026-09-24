import { sql } from 'kysely';
import { expect } from 'vitest';
import { access, attestation } from '../../../src/canton/contracts.js';
import { isExactly, KycAttestation, PoolAccess } from '../../../src/canton/packages.js';
import type { DevelopmentFixtures } from './fixtures.js';
import { at, items, text } from '../../support/json.js';

/** A completed onboarding matches its durable steps and the operator's active contracts. */
export async function completedOnboarding(
  fixtures: DevelopmentFixtures,
  onboarding: unknown,
  expectedPools: readonly string[],
): Promise<void> {
  const trader = text(onboarding, 'party', 'partyId');
  const id = text(onboarding, 'id');
  expect(at(onboarding, 'status')).toBe('COMPLETED');
  expect(at(onboarding, 'partyMode')).toBe('external');
  expect(at(onboarding, 'party', 'confirmed')).toBe(true);
  const pools = items(onboarding, 'review', 'approvedPoolIds');
  expect([...pools].sort()).toEqual([...expectedPools].sort());
  const persisted = await sql<{ pool: string }>`
    SELECT jsonb_array_elements_text(approved_pools) AS pool FROM onboardings WHERE id = ${id}`.execute(fixtures.db);
  expect(persisted.rows.map((row) => row.pool).sort()).toEqual([...expectedPools].sort());
  const ids = new Map<string, string>();
  for (const step of items(onboarding, 'ledgerSteps')) {
    expect(at(step, 'status')).toBe('CONFIRMED');
    ids.set(text(step, 'key'), text(step, 'contractId'));
    const stored = await fixtures.db
      .selectFrom('onboarding_steps')
      .select(['command_id', 'status', 'contract_id', 'update_id', 'issuer'])
      .where('onboarding_id', '=', id)
      .where('step_key', '=', text(step, 'key'))
      .executeTakeFirstOrThrow();
    expect(stored.command_id).toBe(text(step, 'commandId'));
    expect(stored.update_id).toBe(text(step, 'updateId'));
    expect(stored.issuer).toBe(text(step, 'issuer'));
    expect(stored.status).toBe('CONFIRMED');
    expect(stored.contract_id).toBe(text(step, 'contractId'));
  }
  expect(ids.size).toBe(pools.length + 1);
  const account = await fixtures.db
    .selectFrom('accounts')
    .select('party_id')
    .where('id', '=', text(onboarding, 'accountId'))
    .executeTakeFirstOrThrow();
  expect(account.party_id).toBe(trader);

  const operator = fixtures.operatorLedger();
  const operatorParty = await operator.primaryParty();
  const attestations = (await operator.activeContracts(operatorParty, KycAttestation)).filter(
    (event) => isExactly(event.templateId, KycAttestation) && attestation(event.createArgument).trader === trader,
  );
  expect(attestations).toHaveLength(1);
  const [event] = attestations;
  if (!event) throw new Error('No attestation');
  expect(event.signatories).toEqual([operatorParty]);
  expect(event.observers).toContain(trader);
  const rights = await fixtures.admin.rights(fixtures.config.operator.userId);
  expect(rights.some((right) => at(right, 'kind', 'CanActAs', 'value', 'party') === trader)).toBe(false);
  expect(event.contractId).toBe(ids.get('attestation'));
  const value = attestation(event.createArgument);
  expect(value.venueOperator).toBe(operatorParty);
  expect([...value.pools].sort()).toEqual([...pools].sort());
  const accesses = (await operator.activeContracts(operatorParty, PoolAccess)).filter(
    (candidate) => isExactly(candidate.templateId, PoolAccess) && access(candidate.createArgument).trader === trader,
  );
  expect(accesses).toHaveLength(pools.length);
  for (const accessEvent of accesses) {
    const grant = access(accessEvent.createArgument);
    expect(grant.venueOperator).toBe(operatorParty);
    expect(grant.attestationCid).toBe(ids.get('attestation'));
    expect(accessEvent.contractId).toBe(ids.get(`access:${grant.poolCid}`));
  }
}
