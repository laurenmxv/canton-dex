import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { GRPC, LedgerRejected } from '../../src/canton/http.js';
import { exercise, parseStoredCommands } from '../../src/canton/ledger.js';
import { byPackageId, TokenRules, type DamlName } from '../../src/canton/packages.js';
import { jsonText } from '../../src/platform/json.js';
import { DevelopmentFixtures } from './support/fixtures.js';
import { scenario } from './support/scenario.js';

/** The standard allocation factory interface that the test-token rules implement. */
const AllocationFactory: DamlName = {
  packageName: 'splice-api-token-allocation-instruction-v2',
  packageId: '1bc26b40a65ee49c51eefc09a4684443f270f740cbd25a2b8ebd44defde3db26',
  module: 'Splice.Api.Token.AllocationInstructionV2',
  entity: 'AllocationFactory',
};
/** The local participant uses a 30-second maximum deduplication duration. */
const PAST_MAX_DEDUPLICATION_MS = 31_000;

async function grpcCode(run: Promise<unknown>): Promise<number | undefined> {
  const error = await run.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(LedgerRejected);
  return error instanceof LedgerRejected ? error.grpcCode : undefined;
}

describe.runIf(scenario('environment', 'swaps'))('stored submission', () => {
  const fixtures = new DevelopmentFixtures();

  afterAll(() => fixtures.close());

  it('a persisted operator command replays without a second ledger change', async () => {
    const ledger = fixtures.operatorLedger();
    const config = await fixtures.db
      .selectFrom('test_token_configuration')
      .select(['rules_id', 'rules_created_event_blob', 'synchronizer_id'])
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    const disclosure = {
      templateId: byPackageId(TokenRules),
      contractId: config.rules_id,
      createdEventBlob: config.rules_created_event_blob,
      synchronizerId: config.synchronizer_id,
    };
    const operator = await ledger.primaryParty();
    const before = await ledger.ledgerEnd();
    const commands = ledger.storedCommands(
      randomUUID(),
      operator,
      [],
      [exercise(AllocationFactory, config.rules_id, 'AllocationFactory_PublicFetch', { actors: [operator] })],
      before,
      [disclosure],
    );
    // Rehydrate exactly the envelope a durable operation stores before its first dispatch.
    const stored = parseStoredCommands(jsonText(commands));
    const first = await ledger.submitStored(stored);
    expect(first.offset).toBeGreaterThan(before);
    expect(first.updateId.trim()).not.toBe('');
    expect(await grpcCode(ledger.submitStored(stored))).toBe(GRPC.ALREADY_EXISTS);
    // Offset deduplication outlives the participant's maximum duration.
    await sleep(PAST_MAX_DEDUPLICATION_MS);
    const reopened = fixtures.operatorLedger();
    expect(await grpcCode(reopened.submitStored(stored))).toBe(GRPC.ALREADY_EXISTS);
    const history = await ledger.transactions(before, operator);
    expect(
      history
        .filter((transaction) => transaction.commandId === stored.commandId)
        .map((transaction) => transaction.updateId),
    ).toEqual([first.updateId]);
  });
});
