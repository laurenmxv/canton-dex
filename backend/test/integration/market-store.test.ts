import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MarketStore } from '../../src/markets/store.js';
import { jsonText } from '../../src/platform/json.js';
import { epochNanos } from '../../src/platform/time.js';
import type { Terms } from '../../src/swaps/model.js';
import { scenario } from './support/scenario.js';
import { scratchDatabase, type ScratchDatabase } from './support/scratch-database.js';

const DATABASE_URL = process.env.DEX_SETTLEMENT_TEST_DATABASE_URL;

describe.runIf(scenario('swaps') && DATABASE_URL)('market store', () => {
  let scratch: ScratchDatabase;
  const account = randomUUID();

  beforeEach(async () => {
    scratch = await scratchDatabase(DATABASE_URL ?? '');
    await sql`INSERT INTO accounts(id,issuer,subject,display_name,role)
      VALUES(${account},'test','trader','Trader','TRADER')`.execute(scratch.db);
    await sql`INSERT INTO pools(pool_id,config_id,state_id,package_id,name)
      VALUES('pool','config','state','package','Pool')`.execute(scratch.db);
  });

  afterEach(() => scratch.drop());

  async function insert(
    status: 'CONFIRMED' | 'SUBMITTING',
    swapStatus: 'SETTLED' | 'SETTLING',
    settledAt: string,
    direction: 'BaseToQuote' | 'QuoteToBase' = 'BaseToQuote',
  ): Promise<string> {
    const settlement = randomUUID();
    const swap = randomUUID();
    const quote = randomUUID();
    const terms: Terms = {
      poolId: 'pool',
      poolName: 'Pool',
      trader: 'trader',
      direction,
      inputInstrument: { admin: 'issuer', id: direction === 'BaseToQuote' ? 'BTC' : 'USDC' },
      outputInstrument: { admin: 'issuer', id: direction === 'BaseToQuote' ? 'USDC' : 'BTC' },
      amountIn: direction === 'BaseToQuote' ? '1' : '61000',
      expectedOut: direction === 'BaseToQuote' ? '60000' : '1',
      feeAmount: '1',
      minOut: '1',
      settlementDeadline: '2026-10-02T00:00:00Z',
    };
    await sql`INSERT INTO settlement_batches(
        id,pool_id,trigger,status,requests,policy_version,command_id,begin_offset,state_version,updated_at
      ) VALUES(
        ${settlement},'pool','MANUAL',${status},'[]'::jsonb,1,${randomUUID()},0,'state',${settledAt}
      )`.execute(scratch.db);
    await sql`INSERT INTO swap_quotes(id,account_id,payload) VALUES(${quote},${account},'{}')`.execute(
      scratch.db,
    );
    await sql`INSERT INTO swap_requests(
        id,account_id,quote_id,terms,status,settlement_id,amount_out,allocation_cids,created_at,updated_at
      ) VALUES(
        ${swap},${account},${quote},${jsonText(terms)}::jsonb,${swapStatus},${settlement},
        ${direction === 'BaseToQuote' ? '60000' : '1'},'[]'::jsonb,${settledAt},${settledAt}
      )`.execute(scratch.db);
    return swap;
  }

  it('reads only confirmed settled swaps in the inclusive pool window', async () => {
    const boundary = await insert('CONFIRMED', 'SETTLED', '2026-09-30T12:00:00Z');
    const latest = await insert('CONFIRMED', 'SETTLED', '2026-10-01T12:00:00Z', 'QuoteToBase');
    await insert('SUBMITTING', 'SETTLING', '2026-10-01T11:00:00Z');
    await insert('CONFIRMED', 'SETTLED', '2026-09-30T11:59:59Z');

    const trades = await new MarketStore(scratch.db).confirmedTrades(
      'pool',
      epochNanos('2026-09-30T12:00:00Z'),
      epochNanos('2026-10-01T12:00:00Z'),
    );

    expect(trades.map((trade) => trade.swapId)).toEqual([boundary, latest]);
    expect(trades[1]).toMatchObject({
      direction: 'QuoteToBase',
      amountIn: '61000',
      amountOut: '1',
      settledAt: '2026-10-01T12:00:00Z',
    });
  });

  it('returns the same durable evidence after a process restart', async () => {
    const swapId = await insert('CONFIRMED', 'SETTLED', '2026-10-01T11:00:00Z');
    const window = [
      epochNanos('2026-09-30T12:00:00Z'),
      epochNanos('2026-10-01T12:00:00Z'),
    ] as const;
    const before = await new MarketStore(scratch.db).confirmedTrades('pool', ...window);
    const after = await new MarketStore(scratch.reopen()).confirmedTrades('pool', ...window);
    expect(before).toEqual(after);
    expect(after.map((trade) => trade.swapId)).toEqual([swapId]);
  });
});
