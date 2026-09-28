import { createHash } from 'node:crypto';
import type { StaticDecode } from 'typebox';
import { storedNullableText, storedObject, storedText } from '../platform/stored.js';
import { numericUnits, sameNumeric } from '../platform/decimal.js';
import { InvalidRequest } from '../platform/errors.js';
import { isBreakingWhitespace } from '../platform/request.js';
import { Instrument, sameInstrument, type RegisteredInstrument } from '../tokens/model.js';

export const ReserveAccount = storedObject({ owner: storedText, provider: storedNullableText, id: storedText });
export type ReserveAccount = StaticDecode<typeof ReserveAccount>;

const PAIR = { dvo: storedText, baseInstrumentId: Instrument, quoteInstrumentId: Instrument };

/** A pair and a whole-bps fee, as a proposal states them. */
export const ProposalTerms = storedObject({ ...PAIR, feeBps: storedText });
export type ProposalTerms = StaticDecode<typeof ProposalTerms>;

/** Pool settings and reserves; decimals keep the ledger's Numeric 10 text. */
export const Terms = storedObject({
  ...PAIR,
  baseAccount: ReserveAccount,
  quoteAccount: ReserveAccount,
  lpTokenInstrumentId: Instrument,
  feeBps: storedText,
  baseReserve: storedText,
  quoteReserve: storedText,
  lpTokenSupply: storedText,
  initialRatio: storedText,
});
export type Terms = StaticDecode<typeof Terms>;

/** POST /v1/admin/pool-proposals. */
export interface CreateProposal {
  readonly name: string;
  readonly baseInstrumentId: Instrument;
  readonly quoteInstrumentId: Instrument;
  readonly feeBps: string;
}

/** What a proposal is built against. The caller chooses none of the parties. */
export interface Options {
  readonly factoryId: string;
  readonly dvo: string;
  readonly venueOperator: string;
  readonly instruments: readonly RegisteredInstrument[];
}

export const PROPOSAL_STATUSES = [
  'SUBMITTING',
  'PENDING',
  'CREATED',
  'REJECTED',
  'WITHDRAWN',
  'UNRESOLVED',
  'FAILED',
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export interface Proposal {
  readonly proposalId: string;
  readonly name: string;
  readonly settings: ProposalTerms;
  readonly status: ProposalStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly proposedBy: string;
  readonly proposalCid: string | null;
  readonly factoryId: string;
  readonly poolId: string | null;
  readonly updateId: string | null;
  readonly error: string | null;
}

/** A pool with the contracts that hold it, as the API returns it. */
export interface PoolDetail {
  readonly poolId: string;
  readonly name: string;
  readonly settings: Terms;
  readonly configId: string;
  readonly stateId: string;
  readonly packageId: string;
  readonly createdAt: string | null;
  readonly updatedAt: string;
}

/** A pool as the ledger shows it; the store sets `updatedAt` when it saves the pool. */
export type LedgerPool = Omit<PoolDetail, 'updatedAt'>;

/** A proposal whose command outcome or DVO decision the reconciliation still reads. */
export interface PendingProposal {
  readonly proposal: Proposal;
  readonly commandId: string;
  readonly beginOffset: bigint;
}

/** The order-independent identity of an instrument pair; one pool or pending proposal per pair. */
export function pairKey(base: Instrument, quote: Instrument): string {
  const identities = [`${base.admin}\n${base.id}`, `${quote.admin}\n${quote.id}`].sort();
  return createHash('sha256').update(identities.join('\n'), 'utf8').digest('hex');
}

export function proposalOf(terms: Terms): ProposalTerms {
  return {
    dvo: terms.dvo,
    baseInstrumentId: terms.baseInstrumentId,
    quoteInstrumentId: terms.quoteInstrumentId,
    feeBps: terms.feeBps,
  };
}

/** The same authority, pair and fee value, whatever the scale of the two fee texts. */
export function sameProposalTerms(left: ProposalTerms, right: ProposalTerms): boolean {
  return (
    left.dvo === right.dvo &&
    sameInstrument(left.baseInstrumentId, right.baseInstrumentId) &&
    sameInstrument(left.quoteInstrumentId, right.quoteInstrumentId) &&
    sameNumeric(left.feeBps, right.feeBps)
  );
}

const DECIMAL = /^(?:0|[1-9][0-9]{0,27})(?:\.[0-9]{1,10})?$/;
const UNIT = 10n ** 10n;
const MAX_FEE_BPS = 10_000n * UNIT;
/**
 * A valid proposal identifier: no character up to U+0020 at either end, not
 * only breaking whitespace, and no control character (U+0000 to U+001F, U+007F to U+009F).
 */
function validIdentifier(value: string): boolean {
  if (value.length === 0 || value.charCodeAt(0) <= 0x20 || value.charCodeAt(value.length - 1) <= 0x20) return false;
  let blank = true;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false;
    if (!isBreakingWhitespace(code)) blank = false;
  }
  return !blank;
}

function invalid(reason: string): never {
  throw new InvalidRequest(reason);
}

/** A Decimal with up to 28 integer and 10 fraction digits, as exact Numeric 10 units. */
export function decimal(value: string): bigint {
  if (!DECIMAL.test(value)) invalid('Invalid decimal');
  return numericUnits(value);
}

/**
 * The terms of a new proposal. Identifiers are exact; both instruments must be registered and
 * differ; the fee is whole basis points below 10000. The venue's DVO is the authority.
 */
export function proposalTerms(input: CreateProposal, options: Options): ProposalTerms {
  const { baseInstrumentId: base, quoteInstrumentId: quote } = input;
  for (const value of [input.name, base.admin, base.id, quote.admin, quote.id]) {
    if (!validIdentifier(value)) invalid('Invalid pool identifier');
  }
  const registered = (instrument: Instrument) => options.instruments.some((item) => sameInstrument(item, instrument));
  if (!registered(base) || !registered(quote)) invalid('Both instruments must be registered by the venue');
  if (sameInstrument(base, quote)) invalid('Instruments must differ');
  const fee = decimal(input.feeBps);
  if (fee < 0n || fee >= MAX_FEE_BPS || fee % UNIT !== 0n) invalid('Fee must be whole basis points below 10000');
  return { dvo: options.dvo, baseInstrumentId: base, quoteInstrumentId: quote, feeBps: input.feeBps };
}
