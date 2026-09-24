/**
 * The standard CIP-0112 allocation interface: its view and its lifecycle results, independent of
 * the issuer's implementing template.
 */
import { numericUnits } from '../platform/decimal.js';
import { account, int64, numeric, type DamlAccount } from './contracts.js';
import { array, boolean, optionalString, record, string, strings, type JsonRecord } from './decode.js';
import { interfaceView, type CreatedEvent, type ExercisedEvent } from './ledger.js';
import { AllocationInterface, byPackageId } from './packages.js';

const METADATA_PREFIX = 'dex.reference.openzeppelin.com/';
export const MIN_OUT_KEY = `${METADATA_PREFIX}min-out-amount`;
export const MIN_LP_OUT_KEY = `${METADATA_PREFIX}min-lp-out-amount`;
export const MIN_BASE_OUT_KEY = `${METADATA_PREFIX}min-base-out-amount`;
export const MIN_QUOTE_OUT_KEY = `${METADATA_PREFIX}min-quote-out-amount`;

const WITHDRAW_CHOICE = 'Allocation_Withdraw';
const WITHDRAWN_OUTPUT = 'AllocationResult_Withdrawn';

export type Metadata = Readonly<Record<string, string>>;

export interface TransferLegSide {
  readonly transferLegId: string;
  readonly side: string;
  readonly otherside: DamlAccount;
  readonly amount: bigint;
  readonly instrumentId: string;
}

export interface AllocationSpecification {
  readonly admin: string;
  readonly authorizer: DamlAccount;
  readonly transferLegSides: readonly TransferLegSide[];
  readonly settlementDeadline: string | null;
  /** Instrument id to funding units; null when the allocation has no next iteration. */
  readonly nextIterationFunding: ReadonlyMap<string, bigint> | null;
  readonly committed: boolean;
  readonly meta: Metadata;
}

export interface AllocationView {
  readonly executors: readonly string[];
  readonly settlementId: string;
  readonly settlementCid: string | null;
  readonly allocation: AllocationSpecification;
  readonly numIterations: bigint;
}

function metadata(value: unknown, what: string): Metadata {
  const values = record(record(value, what).values, `${what}.values`);
  return Object.fromEntries(Object.entries(values).map(([key, item]) => [key, string(item, `${what}.${key}`)]));
}

function funding(value: unknown, what: string): ReadonlyMap<string, bigint> | null {
  if (value === null || value === undefined) return null;
  const entries = Object.entries(record(value, what));
  return new Map(entries.map(([id, amount]) => [id, numericUnits(numeric(amount, `${what}.${id}`))]));
}

function legSide(value: unknown, what: string): TransferLegSide {
  const fields = record(value, what);
  return {
    transferLegId: string(fields.transferLegId, `${what}.transferLegId`),
    side: string(fields.side, `${what}.side`),
    otherside: account(fields.otherside, `${what}.otherside`),
    amount: numericUnits(numeric(fields.amount, `${what}.amount`)),
    instrumentId: string(fields.instrumentId, `${what}.instrumentId`),
  };
}

/** A standard allocation specification, as views and implementing templates carry it. */
export function allocationSpecification(value: unknown): AllocationSpecification {
  const fields: JsonRecord = record(value, 'AllocationView.allocation');
  return {
    admin: string(fields.admin, 'allocation.admin'),
    authorizer: account(fields.authorizer, 'allocation.authorizer'),
    transferLegSides: array(fields.transferLegSides, 'allocation.transferLegSides', legSide),
    settlementDeadline: optionalString(fields.settlementDeadline, 'allocation.settlementDeadline') ?? null,
    nextIterationFunding: funding(fields.nextIterationFunding, 'allocation.nextIterationFunding'),
    committed: boolean(fields.committed, 'allocation.committed'),
    meta: metadata(fields.meta, 'allocation.meta'),
  };
}

/** The allocation view of a contract that implements the standard interface. */
export function allocationView(event: CreatedEvent): AllocationView {
  const view = record(interfaceView(event, AllocationInterface), 'AllocationView');
  const settlement = record(view.settlement, 'AllocationView.settlement');
  return {
    executors: strings(settlement.executors, 'settlement.executors'),
    settlementId: string(settlement.id, 'settlement.id'),
    settlementCid: optionalString(settlement.cid, 'settlement.cid') ?? null,
    allocation: allocationSpecification(view.allocation),
    numIterations: int64(view.numIterations, 'AllocationView.numIterations'),
  };
}

export function sameMetadata(actual: Metadata, expected: Metadata): boolean {
  const keys = Object.keys(actual);
  return keys.length === Object.keys(expected).length && keys.every((key) => actual[key] === expected[key]);
}

/** A completed standard withdrawal: the interface's nonconsuming choice with a withdrawn result. */
export function withdrawn(event: ExercisedEvent): boolean {
  if (
    event.interfaceId !== byPackageId(AllocationInterface) ||
    event.consuming ||
    event.choice !== WITHDRAW_CHOICE ||
    event.exerciseResult === undefined ||
    event.exerciseResult === null
  ) {
    return false;
  }
  const output = record(record(event.exerciseResult, 'AllocationResult').output, 'AllocationResult.output');
  return output.tag === WITHDRAWN_OUTPUT;
}
