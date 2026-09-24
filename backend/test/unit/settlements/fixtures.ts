import { randomUUID } from 'node:crypto';
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely';
import type { Kind, LiquidityStatus, Mode, Terms } from '../../../src/liquidity/model.js';
import type { Database } from '../../../src/platform/database.js';
import { epochNanos, instantText } from '../../../src/platform/time.js';
import { liquidityRequest, swapRequest, type QueueRequest } from '../../../src/settlements/model.js';
import type { SwapStatus } from '../../../src/swaps/model.js';

export const NOW = epochNanos('2026-01-01T00:00:00Z');
const SECOND = 1_000_000_000n;
const CREATED = instantText(NOW);
const DEADLINE = instantText(NOW + 60n * SECOND);

export function swap(sequence: bigint, status: SwapStatus = 'READY', deadline = DEADLINE): QueueRequest {
  return swapRequest({
    swapId: randomUUID(),
    quoteId: randomUUID(),
    poolId: 'pool',
    poolName: 'Pool',
    trader: 'trader',
    direction: 'BaseToQuote',
    inputInstrument: { admin: 'issuer', id: 'A' },
    outputInstrument: { admin: 'issuer', id: 'B' },
    amountIn: '10',
    expectedOut: '18',
    feeAmount: '0.03',
    minOut: '15',
    settlementDeadline: deadline,
    status,
    arrivalSequence: sequence,
    createdAt: CREATED,
    submittedAt: CREATED,
    updatedAt: CREATED,
    settlementId: null,
    amountOut: null,
    allocationCids: ['allocation'],
    updateId: 'request-update',
    errorCode: null,
    error: null,
    canWithdraw: false,
  });
}

export function liquidity(
  sequence: bigint,
  kind: Kind,
  status: LiquidityStatus,
  mode: Mode = 'PROPORTIONAL',
): QueueRequest {
  const instruments = {
    baseInstrument: { admin: 'issuer', id: 'A' },
    quoteInstrument: { admin: 'issuer', id: 'B' },
    lpInstrument: { admin: 'dvo', id: 'LP' },
  };
  const terms: Terms =
    kind === 'DEPOSIT'
      ? {
          poolId: 'pool',
          poolName: 'Pool',
          trader: 'trader',
          ...instruments,
          mode,
          maxBaseAmount: '1',
          maxQuoteAmount: '2',
          expectedBaseAmount: '1',
          expectedQuoteAmount: '2',
          expectedBaseRefund: '0',
          expectedQuoteRefund: '0',
          expectedLpOut: '1',
          minLpOut: '0.99',
          minRatio: '1.98',
          maxRatio: '2.02',
          initialMinimumLp: null,
          settlementDeadline: DEADLINE,
        }
      : {
          poolId: 'pool',
          poolName: 'Pool',
          trader: 'trader',
          ...instruments,
          lpAmount: '1',
          expectedBaseOut: '1',
          expectedQuoteOut: '2',
          minBaseOut: '0.99',
          minQuoteOut: '1.98',
          settlementDeadline: DEADLINE,
        };
  return liquidityRequest({
    requestId: randomUUID(),
    quoteId: randomUUID(),
    kind,
    terms,
    status,
    arrivalSequence: sequence,
    createdAt: CREATED,
    submittedAt: CREATED,
    updatedAt: CREATED,
    settlementId: null,
    result: null,
    allocationCids: ['a', 'b', 'c'],
    updateId: null,
    errorCode: null,
    error: null,
    canRecover: false,
  });
}

/** A query builder without a connection, for stores whose tested paths never query. */
export function withoutDatabase(): Kysely<Database> {
  return new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}
