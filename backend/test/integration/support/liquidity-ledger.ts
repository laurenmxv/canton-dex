import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { allocationView } from '../../../src/canton/allocations.js';
import { access } from '../../../src/canton/contracts.js';
import { InteractiveTransactions } from '../../../src/canton/interactive.js';
import { create, exercise, type Ledger } from '../../../src/canton/ledger.js';
import { AllocationInterface, PoolAccess } from '../../../src/canton/packages.js';
import { CantonTokenRegistry } from '../../../src/canton/token-registry.js';
import type { Account } from '../../../src/iam/accounts.js';
import { clockNanos, instantText } from '../../../src/platform/time.js';
import { TokenRegistryStore } from '../../../src/tokens/registry-store.js';
import { TokenStore } from '../../../src/tokens/store.js';
import type { KeyPair } from './backend.js';
import type { DevelopmentFixtures } from './fixtures.js';
import { walletSignature } from './traders.js';
import { SIGNING_WINDOW } from './wallet.js';

/** Archives the trader's pool access and returns its arguments, so that the test can restore it. */
export async function revokeAccess(ledger: Ledger, trader: string, poolId: string): Promise<unknown> {
  const operator = await ledger.primaryParty();
  const accesses = (await ledger.activeContracts(operator, PoolAccess)).filter((event) => {
    const value = access(event.createArgument);
    return value.trader === trader && value.poolCid === poolId;
  });
  expect(accesses).toHaveLength(1);
  const [grant] = accesses;
  if (!grant) throw new Error('No pool access');
  await ledger.submit(randomUUID(), operator, [], [exercise(PoolAccess, grant.contractId, 'Archive', {})]);
  expect((await ledger.activeContracts(operator, PoolAccess)).map((event) => event.contractId)).not.toContain(
    grant.contractId,
  );
  return grant.createArgument;
}

export async function restoreAccess(ledger: Ledger, accessArguments: unknown): Promise<void> {
  await ledger.submit(randomUUID(), await ledger.primaryParty(), [], [create(PoolAccess, accessArguments)]);
}

/** The trader withdraws one allocation directly through the token standard, with its own wallet key. */
export async function withdrawAllocation(
  fixtures: DevelopmentFixtures,
  callerToken: string,
  trader: string,
  key: KeyPair,
  allocationCid: string,
): Promise<void> {
  const row = await fixtures.db
    .selectFrom('accounts')
    .select(['id', 'issuer', 'subject', 'display_name'])
    .where('party_id', '=', trader)
    .executeTakeFirstOrThrow();
  const account: Account = {
    id: row.id,
    issuer: row.issuer,
    subject: row.subject,
    displayName: row.display_name,
    role: 'TRADER',
  };
  const signer = (await new TokenStore(fixtures.db).signer(account)).party;
  const caller = fixtures.operatorLedger().forCaller(callerToken);
  const event = (await caller.activeInterfaceContracts(trader, AllocationInterface)).find(
    (candidate) => candidate.contractId === allocationCid,
  );
  if (!event) throw new Error(`Allocation ${allocationCid} is not active`);
  const context = await new CantonTokenRegistry(new TokenRegistryStore(fixtures.db)).withdraw(
    allocationView(event).allocation.admin,
    allocationCid,
  );
  const interactive = new InteractiveTransactions(fixtures.http);
  const commandId = randomUUID();
  const prepared = await interactive.prepare(
    commandId,
    account.subject,
    callerToken,
    signer,
    exercise(AllocationInterface, allocationCid, 'Allocation_Withdraw', {
      actors: [trader],
      extraArgs: context.extraArgs,
    }),
    context.disclosures,
    instantText(clockNanos() + SIGNING_WINDOW),
  );
  const signature = walletSignature(key, Buffer.from(prepared.preparedTransactionHash, 'base64'));
  await interactive.execute(commandId, prepared, signature, signer, callerToken, account.subject);
  expect(
    (await caller.activeInterfaceContracts(trader, AllocationInterface)).map((item) => item.contractId),
  ).not.toContain(allocationCid);
}
