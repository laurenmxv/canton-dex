/**
 * The JSON encoding of the Daml records that the adapter reads and writes. Values use the JSON
 * Ledger API encoding: parties, contract ids and text as strings, Numeric and Int64 as strings,
 * Optional as null or the value, and records as objects with field names.
 */
import type { Instrument } from '../tokens/model.js';
import { numericText, numericUnits } from '../platform/decimal.js';
import { array, boolean, record, string, strings } from './decode.js';

export interface DamlAccount {
  readonly owner: string | null;
  readonly provider: string | null;
  readonly id: string;
}

export interface Token {
  readonly instrument: Instrument;
  readonly allocationFactory: string;
  readonly settlementFactory: string;
  readonly decimals: bigint;
}

export interface PoolContract {
  readonly dvo: string;
  readonly venueOperator: string;
  readonly baseToken: Token;
  readonly quoteToken: Token;
  readonly lpToken: Token;
  readonly baseAccount: DamlAccount;
  readonly quoteAccount: DamlAccount;
}

export interface PoolConfigContract {
  readonly poolCid: string;
  readonly dvo: string;
  readonly venueOperator: string;
  readonly feeBps: string;
  readonly initialRatio: string;
}

export interface PoolStateContract {
  readonly poolCid: string;
  readonly dvo: string;
  readonly venueOperator: string;
  readonly baseReserve: string;
  readonly quoteReserve: string;
  readonly lpTokenSupply: string;
  readonly baseHoldingCids: readonly string[];
  readonly quoteHoldingCids: readonly string[];
}

export interface PoolSettings {
  readonly dvo: string;
  readonly poolId: string;
  readonly baseToken: Token;
  readonly quoteToken: Token;
  readonly lpAllocationFactory: string;
  readonly lpSettlementFactory: string;
  readonly feeBps: string;
}

export interface PoolProposalContract {
  readonly factoryCid: string;
  readonly venueOperator: string;
  readonly settings: PoolSettings;
  readonly accepted: boolean;
}

export interface PoolFactoryContract {
  readonly dvo: string;
  readonly venueOperator: string;
}

export interface VenueDelegationContract {
  readonly dvo: string;
  readonly venueOperator: string;
  readonly poolCid: string;
}

/** The standard `HoldingV2` view; `locked` is whether the holding carries a lock. */
export interface HoldingView {
  readonly account: DamlAccount;
  readonly instrumentId: Instrument;
  readonly amount: string;
  readonly locked: boolean;
}

export interface TestTokenAmount {
  readonly instrumentId: string;
  readonly amount: string;
}

export interface Attestation {
  readonly venueOperator: string;
  readonly trader: string;
  readonly pools: readonly string[];
}

export interface Access {
  readonly venueOperator: string;
  readonly trader: string;
  readonly poolCid: string;
  readonly attestationCid: string;
}

/** A Numeric 10 value in the plain scale-10 text of the API, whatever form the participant wrote. */
export function numeric(value: unknown, what: string): string {
  return numericText(numericUnits(string(value, what)));
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** A Daml Int64, exact over its full range. */
export function int64(value: unknown, what: string): bigint {
  // The participant writes Int64 as a string; `parseLedgerJson` makes a large number a bigint.
  const source = typeof value === 'number' || typeof value === 'bigint' ? String(value) : string(value, what);
  const parsed = /^-?\d+$/.test(source) ? BigInt(source) : undefined;
  if (parsed === undefined || parsed < INT64_MIN || parsed > INT64_MAX) {
    throw new Error(`Unexpected participant response: ${what} is not an Int64`);
  }
  return parsed;
}

function optionalText(value: unknown, what: string): string | null {
  return value === null || value === undefined ? null : string(value, what);
}

export function instrument(value: unknown, what = 'instrument'): Instrument {
  const fields = record(value, what);
  return { admin: string(fields.admin, `${what}.admin`), id: string(fields.id, `${what}.id`) };
}

export function account(value: unknown, what = 'account'): DamlAccount {
  const fields = record(value, what);
  return {
    owner: optionalText(fields.owner, `${what}.owner`),
    provider: optionalText(fields.provider, `${what}.provider`),
    id: string(fields.id, `${what}.id`),
  };
}

export function token(value: unknown, what = 'token'): Token {
  const fields = record(value, what);
  return {
    instrument: instrument(fields.instrument, `${what}.instrument`),
    allocationFactory: string(fields.allocationFactory, `${what}.allocationFactory`),
    settlementFactory: string(fields.settlementFactory, `${what}.settlementFactory`),
    decimals: int64(fields.decimals, `${what}.decimals`),
  };
}

export function encodeToken(value: Token): Record<string, unknown> {
  return { ...value, decimals: String(value.decimals) };
}

export function pool(value: unknown): PoolContract {
  const fields = record(value, 'Pool');
  return {
    dvo: string(fields.dvo, 'Pool.dvo'),
    venueOperator: string(fields.venueOperator, 'Pool.venueOperator'),
    baseToken: token(fields.baseToken, 'Pool.baseToken'),
    quoteToken: token(fields.quoteToken, 'Pool.quoteToken'),
    lpToken: token(fields.lpToken, 'Pool.lpToken'),
    baseAccount: account(fields.baseAccount, 'Pool.baseAccount'),
    quoteAccount: account(fields.quoteAccount, 'Pool.quoteAccount'),
  };
}

export function poolConfig(value: unknown): PoolConfigContract {
  const fields = record(value, 'PoolConfig');
  return {
    poolCid: string(fields.poolCid, 'PoolConfig.poolCid'),
    dvo: string(fields.dvo, 'PoolConfig.dvo'),
    venueOperator: string(fields.venueOperator, 'PoolConfig.venueOperator'),
    feeBps: numeric(fields.feeBps, 'PoolConfig.feeBps'),
    initialRatio: numeric(fields.initialRatio, 'PoolConfig.initialRatio'),
  };
}

export function poolState(value: unknown): PoolStateContract {
  const fields = record(value, 'PoolState');
  return {
    poolCid: string(fields.poolCid, 'PoolState.poolCid'),
    dvo: string(fields.dvo, 'PoolState.dvo'),
    venueOperator: string(fields.venueOperator, 'PoolState.venueOperator'),
    baseReserve: numeric(fields.baseReserve, 'PoolState.baseReserve'),
    quoteReserve: numeric(fields.quoteReserve, 'PoolState.quoteReserve'),
    lpTokenSupply: numeric(fields.lpTokenSupply, 'PoolState.lpTokenSupply'),
    baseHoldingCids: strings(fields.baseHoldingCids, 'PoolState.baseHoldingCids'),
    quoteHoldingCids: strings(fields.quoteHoldingCids, 'PoolState.quoteHoldingCids'),
  };
}

export function poolSettings(value: unknown): PoolSettings {
  const fields = record(value, 'PoolSettings');
  return {
    dvo: string(fields.dvo, 'PoolSettings.dvo'),
    poolId: string(fields.poolId, 'PoolSettings.poolId'),
    baseToken: token(fields.baseToken, 'PoolSettings.baseToken'),
    quoteToken: token(fields.quoteToken, 'PoolSettings.quoteToken'),
    lpAllocationFactory: string(fields.lpAllocationFactory, 'PoolSettings.lpAllocationFactory'),
    lpSettlementFactory: string(fields.lpSettlementFactory, 'PoolSettings.lpSettlementFactory'),
    feeBps: numeric(fields.feeBps, 'PoolSettings.feeBps'),
  };
}

export function encodePoolSettings(value: PoolSettings): Record<string, unknown> {
  return { ...value, baseToken: encodeToken(value.baseToken), quoteToken: encodeToken(value.quoteToken) };
}

export function poolProposal(value: unknown): PoolProposalContract {
  const fields = record(value, 'PoolProposal');
  return {
    factoryCid: string(fields.factoryCid, 'PoolProposal.factoryCid'),
    venueOperator: string(fields.venueOperator, 'PoolProposal.venueOperator'),
    settings: poolSettings(fields.settings),
    accepted: boolean(fields.accepted, 'PoolProposal.accepted'),
  };
}

export function poolFactory(value: unknown): PoolFactoryContract {
  const fields = record(value, 'PoolFactory');
  return {
    dvo: string(fields.dvo, 'PoolFactory.dvo'),
    venueOperator: string(fields.venueOperator, 'PoolFactory.venueOperator'),
  };
}

export function venueDelegation(value: unknown): VenueDelegationContract {
  const fields = record(value, 'VenueDelegation');
  return {
    dvo: string(fields.dvo, 'VenueDelegation.dvo'),
    venueOperator: string(fields.venueOperator, 'VenueDelegation.venueOperator'),
    poolCid: string(fields.poolCid, 'VenueDelegation.poolCid'),
  };
}

export function holdingView(value: unknown): HoldingView {
  const fields = record(value, 'HoldingView');
  return {
    account: account(fields.account, 'HoldingView.account'),
    instrumentId: instrument(fields.instrumentId, 'HoldingView.instrumentId'),
    amount: numeric(fields.amount, 'HoldingView.amount'),
    locked: fields.lock !== null && fields.lock !== undefined,
  };
}

export function testTokenAmounts(value: unknown, what: string): TestTokenAmount[] {
  return array(value, what, (item, itemWhat) => {
    const fields = record(item, itemWhat);
    return {
      instrumentId: string(fields.instrumentId, `${itemWhat}.instrumentId`),
      amount: numeric(fields.amount, `${itemWhat}.amount`),
    };
  });
}

export function attestation(value: unknown): Attestation {
  const fields = record(value, 'KycAttestation');
  return {
    venueOperator: string(fields.venueOperator, 'KycAttestation.venueOperator'),
    trader: string(fields.trader, 'KycAttestation.trader'),
    pools: strings(fields.pools, 'KycAttestation.pools'),
  };
}

export function access(value: unknown): Access {
  const fields = record(value, 'PoolAccess');
  return {
    venueOperator: string(fields.venueOperator, 'PoolAccess.venueOperator'),
    trader: string(fields.trader, 'PoolAccess.trader'),
    poolCid: string(fields.poolCid, 'PoolAccess.poolCid'),
    attestationCid: string(fields.attestationCid, 'PoolAccess.attestationCid'),
  };
}

export function sameAttestation(left: Attestation, right: Attestation): boolean {
  return (
    left.venueOperator === right.venueOperator &&
    left.trader === right.trader &&
    left.pools.length === right.pools.length &&
    left.pools.every((poolId, index) => poolId === right.pools[index])
  );
}

export function sameAccess(left: Access, right: Access): boolean {
  return (
    left.venueOperator === right.venueOperator &&
    left.trader === right.trader &&
    left.poolCid === right.poolCid &&
    left.attestationCid === right.attestationCid
  );
}

export function sameAccount(left: DamlAccount, right: DamlAccount): boolean {
  return left.owner === right.owner && left.provider === right.provider && left.id === right.id;
}
