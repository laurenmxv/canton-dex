import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ServiceCredentials } from '../../../src/canton/credentials.js';
import { LedgerHttp, LedgerRejected } from '../../../src/canton/http.js';
import { Ledger, parseStoredCommands, transactionFilter, type Command } from '../../../src/canton/ledger.js';
import { DEX_PACKAGE_ID } from '../../../src/canton/packages.js';
import { LedgerUnavailable } from '../../../src/platform/errors.js';
import { jsonText } from '../../../src/platform/json.js';
import { at, without } from '../../support/json.js';
import {
  cantonError,
  fakeParticipant,
  TOKEN_ROUTE,
  type Answer,
  type FakeParticipant,
} from '../support/participant.js';

const COMMAND: Command = { CreateCommand: { templateId: 'package:Test:Rules', createArguments: {} } };
const DEADLINE = Date.parse('2099-01-01T00:00:00Z');
const at_ = (offsetSeconds: number) => new Date(DEADLINE + offsetSeconds * 1_000).toISOString().replace('.000Z', 'Z');

function checkpoint(offset: number, synchronizerId: string, recordTime: string) {
  return { update: { OffsetCheckpoint: { value: { offset, synchronizerTimes: [{ synchronizerId, recordTime }] } } } };
}

function transactionUpdate(offset: number, synchronizerId: string, recordTime: string, effectiveAt = recordTime) {
  return {
    update: {
      Transaction: {
        value: {
          updateId: `update-${String(offset)}`,
          commandId: '',
          effectiveAt,
          events: [],
          offset,
          synchronizerId,
          recordTime,
        },
      },
    },
  };
}

describe('ledger recovery', () => {
  let participant: FakeParticipant;
  let ledger: Ledger;
  let updates: unknown[];
  let updatesFailure: Answer | undefined;
  let submitFailure: Answer | undefined;

  beforeEach(async () => {
    updates = [];
    updatesFailure = undefined;
    submitFailure = undefined;
    participant = await fakeParticipant({
      ...TOKEN_ROUTE,
      'GET /v2/state/ledger-end': () => ({ body: { offset: 40 } }),
      'GET /v2/state/connected-synchronizers': () => ({
        body: { connectedSynchronizers: [{ synchronizerAlias: 'global', synchronizerId: 'synchronizer' }] },
      }),
      'POST /v2/updates': () => updatesFailure ?? { body: updates },
      'POST /v2/commands/submit-and-wait-for-transaction': () =>
        submitFailure ?? {
          body: {
            transaction: {
              updateId: 'confirmed',
              effectiveAt: at_(0),
              events: [],
              offset: 41,
              synchronizerId: 'synchronizer',
              recordTime: at_(0),
            },
          },
        },
    });
    const credentials = new ServiceCredentials(new URL('/token', participant.url), {
      userId: 'operator-user',
      clientId: 'operator',
      clientSecret: 'secret',
    });
    ledger = Ledger.service(new LedgerHttp(participant.url), credentials);
  });
  afterEach(() => participant.close());

  const requests = (path: string) => participant.exchanges.filter((exchange) => exchange.path === path);
  const updateRequest = () => requests('/v2/updates')[0]?.body;
  const submissions = () => requests('/v2/commands/submit-and-wait-for-transaction').map((exchange) => exchange.body);

  it('proves progress with a checkpoint and no visible transactions', async () => {
    updates.push(checkpoint(40, 'synchronizer', at_(1)));
    const history = await ledger.history(10n, 'operator');
    expect(history.transactions).toEqual([]);
    expect(history.recordTime).toBe(at_(1));
    expect(history.endOffset).toBe(40n);
    expect(at(updateRequest(), 'beginExclusive')).toBe(10);
    expect(at(updateRequest(), 'endInclusive')).toBe(40);
    const filters = at(updateRequest(), 'updateFormat', 'includeTransactions', 'eventFormat', 'filtersByParty');
    expect(filters).toEqual({ operator: transactionFilter() });
  });

  it('never uses another synchronizer or a checkpoint beyond the snapshot', async () => {
    updates.push(checkpoint(40, 'other-synchronizer', at_(5)), checkpoint(41, 'synchronizer', at_(5)));
    expect((await ledger.history(10n, 'operator')).recordTime).toBeUndefined();
  });

  it('falls back to the same synchronizer record time, not the ledger effective time', async () => {
    updates.push(
      transactionUpdate(30, 'synchronizer', at_(-1), at_(500)),
      transactionUpdate(35, 'other-synchronizer', at_(500)),
    );
    const history = await ledger.history(10n, 'operator');
    expect(history.transactions).toHaveLength(2);
    expect(history.recordTime).toBe(at_(-1));
  });

  it('overlaps an unchanged offset for a checkpoint but does not replay its transaction', async () => {
    updates.push(transactionUpdate(40, 'synchronizer', at_(-5)), checkpoint(40, 'synchronizer', at_(1)));
    const history = await ledger.history(40n, 'operator');
    expect(at(updateRequest(), 'beginExclusive')).toBe(39);
    expect(history.transactions).toEqual([]);
    expect(history.recordTime).toBe(at_(1));
  });

  it('never returns a partial absence proof from an interrupted stream', async () => {
    updates.push(checkpoint(20, 'synchronizer', at_(1)));
    updatesFailure = cantonError(503, 14, 'Stream interrupted');
    await expect(ledger.history(10n, 'operator')).rejects.toBeInstanceOf(LedgerUnavailable);
  });

  it('replays the stored commands, disclosures, offset and unknown fields', async () => {
    const disclosure = {
      contractId: 'rules',
      templateId: 'package:Test:Rules',
      createdEventBlob: Buffer.from('blob').toString('base64'),
      synchronizerId: 'synchronizer',
    };
    const built = ledger.storedCommands('batch', 'operator', ['vault'], [COMMAND], 17n, [disclosure]);
    // The stored text keeps fields this version does not know, at the top level and in commands.
    const withUnknown = { ...built, unknownExtension: 'opaque', commands: [{ ...COMMAND, unknownField: 'opaque' }] };
    const stored = parseStoredCommands(jsonText(withUnknown));
    expect((await ledger.submitStored(stored)).updateId).toBe('confirmed');
    expect((await ledger.submitStored(stored)).updateId).toBe('confirmed');
    expect(submissions()).toHaveLength(2);
    expect(stored.deduplicationPeriod).toEqual({ DeduplicationOffset: { value: 17n } });
    expect(stored.actAs).toEqual(['operator']);
    expect(stored.readAs).toEqual(['vault']);
    expect(stored.disclosedContracts).toEqual([disclosure]);
    expect(stored.packageIdSelectionPreference).toEqual([DEX_PACKAGE_ID]);
    for (const request of submissions()) {
      expect(typeof at(request, 'commands', 'submissionId')).toBe('string');
      expect(without(at(request, 'commands'), 'submissionId')).toEqual(JSON.parse(jsonText(stored)));
      expect(at(request, 'transactionFormat', 'eventFormat', 'filtersByParty')).toEqual({
        operator: transactionFilter(),
        vault: transactionFilter(),
      });
    }
    expect(at(submissions()[0], 'commands', 'submissionId')).not.toBe(at(submissions()[1], 'commands', 'submissionId'));
    const ledgerCalls = participant.exchanges.filter((exchange) => exchange.path.startsWith('/v2/'));
    expect(ledgerCalls.length).toBeGreaterThan(0);
    expect(ledgerCalls.every((exchange) => exchange.authorization === 'Bearer service-token')).toBe(true);
  });

  it('includes the standard views in a direct submission without pinning an issuer package', async () => {
    await ledger.submit('command', 'operator', ['vault'], [COMMAND]);
    const [request] = submissions();
    expect(at(request, 'commands', 'packageIdSelectionPreference')).toEqual([DEX_PACKAGE_ID]);
    expect(at(request, 'transactionFormat', 'eventFormat', 'filtersByParty')).toEqual({
      operator: transactionFilter(),
      vault: transactionFilter(),
    });
  });

  it('propagates a submission failure without retry or a change to the stored intent', async () => {
    const stored = ledger.storedCommands('batch', 'operator', [], [COMMAND], 0n, []);
    const failures: [Answer, number][] = [
      [cantonError(504, 4, 'Deadline exceeded'), 4],
      [cantonError(409, 6, 'Already exists'), 6],
      [cantonError(409, 10, 'Aborted'), 10],
      [cantonError(400, 9, 'Failed precondition'), 9],
    ];
    for (const [failure, grpcCode] of failures) {
      submitFailure = failure;
      const error = await ledger.submitStored(stored).catch((e: unknown) => e);
      if (grpcCode === 4) expect(error).toBeInstanceOf(LedgerUnavailable);
      else expect(error instanceof LedgerRejected ? error.grpcCode : undefined).toBe(grpcCode);
    }
    expect(submissions()).toHaveLength(4);
    for (const request of submissions()) {
      expect(at(request, 'commands', 'deduplicationPeriod')).toEqual({ DeduplicationOffset: { value: 0 } });
      expect(at(request, 'commands', 'commandId')).toBe('batch');
    }
  });

  it('requires the original user and offset before calling the participant', async () => {
    const stored = ledger.storedCommands('batch', 'operator', [], [COMMAND], 17n, []);
    await expect(ledger.submitStored({ ...stored, userId: 'other-user' })).rejects.toThrow();
    const { deduplicationPeriod: _withoutOffset, ...unbounded } = stored;
    await expect(ledger.submitStored(unbounded)).rejects.toThrow();
    await expect(
      ledger.submitStored({ ...stored, deduplicationPeriod: { DeduplicationOffset: { value: -1n } } }),
    ).rejects.toThrow();
    expect(submissions()).toEqual([]);
  });
});
