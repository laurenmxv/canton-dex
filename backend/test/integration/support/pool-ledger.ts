import { expect } from 'vitest';
import {
  account,
  instrument,
  numeric,
  pool,
  poolConfig,
  poolState,
  type DamlAccount,
} from '../../../src/canton/contracts.js';
import { record } from '../../../src/canton/decode.js';
import type { CreatedEvent, Ledger } from '../../../src/canton/ledger.js';
import { DEX_PACKAGE_ID, packageOf, Pool, PoolConfig, PoolState, TokenHolding } from '../../../src/canton/packages.js';
import { poolTerms } from '../../../src/canton/pools.js';
import { numericUnits } from '../../../src/platform/decimal.js';
import type { Terms } from '../../../src/pools/model.js';
import type { Instrument } from '../../../src/tokens/model.js';

export interface PoolDetail {
  readonly poolId: string;
  readonly packageId: string;
  readonly settings: Terms;
}

const current = (event: CreatedEvent) => packageOf(event.templateId) === DEX_PACKAGE_ID;

/** The operator's catalog of current-package pools of this DVO, with one config and state each. */
export async function poolCatalog(ledger: Ledger, dvo: string): Promise<PoolDetail[]> {
  const operator = await ledger.primaryParty();
  const configs = (await ledger.activeContracts(operator, PoolConfig)).filter(current);
  const states = (await ledger.activeContracts(operator, PoolState)).filter(current);
  const details: PoolDetail[] = [];
  for (const event of (await ledger.activeContracts(operator, Pool)).filter(current)) {
    const value = pool(event.createArgument);
    if (value.dvo !== dvo || value.venueOperator !== operator) continue;
    const config = configs.filter((candidate) => poolConfig(candidate.createArgument).poolCid === event.contractId);
    const state = states.filter((candidate) => poolState(candidate.createArgument).poolCid === event.contractId);
    const [configEvent] = config;
    const [stateEvent] = state;
    if (config.length !== 1 || state.length !== 1 || !configEvent || !stateEvent) {
      throw new Error('Pool does not have one current config and state');
    }
    details.push({
      poolId: event.contractId,
      packageId: packageOf(event.templateId),
      settings: poolTerms(value, poolConfig(configEvent.createArgument), poolState(stateEvent.createArgument)),
    });
  }
  return details;
}

function total(
  holdings: readonly CreatedEvent[],
  ids: readonly string[],
  owner: DamlAccount,
  token: Instrument,
): bigint {
  const unique = new Set(ids);
  expect(unique.size).toBe(ids.length);
  const selected = holdings.filter((event) => unique.has(event.contractId));
  expect(selected).toHaveLength(ids.length);
  let sum = 0n;
  for (const event of selected) {
    const holding = record(record(event.createArgument, 'TokenHolding').holding, 'holding');
    expect(account(holding.account)).toEqual(owner);
    expect(instrument(holding.instrumentId)).toEqual(token);
    expect(holding.lock ?? null).toBeNull();
    sum += numericUnits(numeric(holding.amount, 'holding.amount'));
  }
  return sum;
}

/** The pool state's reserves equal the DVO's unlocked holdings in the pool accounts. */
export async function backing(ledger: Ledger, poolId: string): Promise<void> {
  const offset = await ledger.ledgerEnd();
  const poolEvent = (await ledger.activeContracts(await ledger.primaryParty(), Pool, offset)).find(
    (event) => current(event) && event.contractId === poolId,
  );
  if (!poolEvent) throw new Error(`Pool ${poolId} is not active`);
  const value = pool(poolEvent.createArgument);
  const states = (await ledger.activeContracts(value.dvo, PoolState, offset))
    .filter(current)
    .map((event) => poolState(event.createArgument))
    .filter((state) => state.poolCid === poolId);
  expect(states).toHaveLength(1);
  const [state] = states;
  if (!state) throw new Error('No pool state');
  const holdings = await ledger.activeContracts(value.dvo, TokenHolding, offset);
  expect(total(holdings, state.baseHoldingCids, value.baseAccount, value.baseToken.instrument)).toBe(
    numericUnits(state.baseReserve),
  );
  expect(total(holdings, state.quoteHoldingCids, value.quoteAccount, value.quoteToken.instrument)).toBe(
    numericUnits(state.quoteReserve),
  );
}
