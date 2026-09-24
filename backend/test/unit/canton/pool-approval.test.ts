import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ExercisedEvent, LedgerEvent, Transaction } from '../../../src/canton/ledger.js';
import {
  byPackageId,
  Pool,
  PoolConfig,
  PoolFactory,
  PoolProposal,
  PoolState,
  type DamlName,
} from '../../../src/canton/packages.js';
import { acceptedPool } from '../../../src/canton/pool-ledger.js';
import { proposalOf, sameProposalTerms, type ProposalTerms } from '../../../src/pools/model.js';

const PROPOSAL_ID = randomUUID();
const TERMS: ProposalTerms = {
  dvo: 'dvo',
  baseInstrumentId: { admin: 'base-admin', id: 'BASE' },
  quoteInstrumentId: { admin: 'quote-admin', id: 'QUOTE' },
  feeBps: '30',
};

function token(issuer: string, id: string) {
  return {
    instrument: { admin: issuer, id },
    allocationFactory: `${issuer}-rules`,
    settlementFactory: `${issuer}-rules`,
    decimals: '10',
  };
}

function settings(feeBps = '30.0000000000') {
  return {
    dvo: 'dvo',
    poolId: PROPOSAL_ID,
    baseToken: token('base-admin', 'BASE'),
    quoteToken: token('quote-admin', 'QUOTE'),
    lpAllocationFactory: 'lp-rules',
    lpSettlementFactory: 'lp-rules',
    feeBps,
  };
}

function approval(changes: Record<string, unknown> = {}) {
  return {
    factoryCid: 'factory',
    venueOperator: 'operator',
    settings: settings(),
    accepted: true,
    initialRatio: '1.0000000000',
    ...changes,
  };
}

function created(
  contractId: string,
  template: DamlName,
  createArgument: unknown,
  signatories: string[],
  observers: string[],
): LedgerEvent {
  return {
    created: {
      offset: 1n,
      contractId,
      templateId: byPackageId(template),
      createArgument,
      createdEventBlob: '',
      interfaceViews: [],
      signatories,
      observers,
      createdAt: '1970-01-01T00:00:00Z',
    },
  };
}

function exercised(
  contractId: string,
  template: DamlName,
  choice: string,
  consuming: boolean,
  actingParties: string[],
  choiceArgument: unknown = {},
): LedgerEvent {
  return {
    exercised: {
      contractId,
      templateId: byPackageId(template),
      choice,
      consuming,
      actingParties,
      choiceArgument,
      exerciseResult: null,
    },
  };
}

function events(): LedgerEvent[] {
  return [
    created('approval', PoolProposal, approval(), ['operator', 'dvo'], []),
    created(
      'pool',
      Pool,
      {
        dvo: 'dvo',
        venueOperator: 'operator',
        baseToken: token('base-admin', 'BASE'),
        quoteToken: token('quote-admin', 'QUOTE'),
        lpToken: token('dvo', `lp:${PROPOSAL_ID}`),
        baseAccount: { owner: 'dvo', provider: 'operator', id: `base:${PROPOSAL_ID}` },
        quoteAccount: { owner: 'dvo', provider: 'operator', id: `quote:${PROPOSAL_ID}` },
      },
      ['dvo'],
      ['operator'],
    ),
    created(
      'config',
      PoolConfig,
      { poolCid: 'pool', dvo: 'dvo', venueOperator: 'operator', feeBps: '30.0000000000', initialRatio: '1.0000000000' },
      ['dvo'],
      ['operator'],
    ),
    created(
      'state',
      PoolState,
      {
        poolCid: 'pool',
        dvo: 'dvo',
        venueOperator: 'operator',
        baseReserve: '0.0000000000',
        quoteReserve: '0.0000000000',
        lpTokenSupply: '0.0000000000',
        baseHoldingCids: [],
        quoteHoldingCids: [],
      },
      ['dvo'],
      ['operator'],
    ),
    exercised('factory', PoolFactory, 'PoolFactory_CreatePool', false, ['dvo', 'operator'], {
      proposalCid: 'approval',
    }),
    exercised('approval', PoolProposal, 'Archive', true, ['dvo', 'operator']),
  ];
}

function transaction(items: LedgerEvent[]): Transaction {
  return {
    updateId: 'accepted',
    commandId: '',
    offset: 1n,
    synchronizerId: 'synchronizer',
    recordTime: '1970-01-01T00:00:00Z',
    effectiveAt: '1970-01-01T00:00:00Z',
    events: items,
  };
}

function accept(items: LedgerEvent[]) {
  return acceptedPool(transaction(items), PROPOSAL_ID, TERMS, 'factory', 'BASE / QUOTE', 'operator');
}

function replaced(index: number, event: LedgerEvent): LedgerEvent[] {
  const items = events();
  items[index] = event;
  return items;
}

function exercise(index: number): ExercisedEvent {
  const event = events()[index];
  if (!event || !('exercised' in event)) throw new Error('Expected an exercised event');
  return event.exercised;
}

describe('pool approval', () => {
  it('confirms the pool alongside its created and consumed approval', () => {
    const result = accept(events());
    expect(result.poolId).toBe('pool');
    expect(result.configId).toBe('config');
    expect(result.stateId).toBe('state');
    expect(sameProposalTerms(proposalOf(result.settings), TERMS)).toBe(true);
  });

  it('rejects a missing approval and an unconsumed or unrelated approval', () => {
    for (const missing of [0, 4, 5]) {
      const items = events();
      items.splice(missing, 1);
      expect(() => accept(items)).toThrow();
    }
    for (const index of [4, 5]) {
      for (const actor of ['dvo', 'operator']) {
        expect(() => accept(replaced(index, { exercised: { ...exercise(index), actingParties: [actor] } }))).toThrow();
      }
    }
    for (const invalid of [
      { ...exercise(5), consuming: false },
      { ...exercise(5), contractId: 'other-approval' },
    ]) {
      expect(() => accept(replaced(5, { exercised: invalid }))).toThrow();
    }
    expect(() =>
      accept(replaced(4, { exercised: { ...exercise(4), choiceArgument: { proposalCid: 'other-approval' } } })),
    ).toThrow();
  });

  it('rejects an approval with a different factory or settings or without consent', () => {
    for (const changes of [
      { factoryCid: 'other-factory' },
      { venueOperator: 'other-operator' },
      { accepted: false, initialRatio: null },
    ]) {
      expect(() =>
        accept(replaced(0, created('approval', PoolProposal, approval(changes), ['operator', 'dvo'], []))),
      ).toThrow();
    }
    for (const signatories of [['dvo'], ['operator']]) {
      expect(() => accept(replaced(0, created('approval', PoolProposal, approval(), signatories, [])))).toThrow();
    }
    const different = approval({ settings: settings('100.0000000000') });
    expect(() => accept(replaced(0, created('approval', PoolProposal, different, ['operator', 'dvo'], [])))).toThrow();
  });
});
