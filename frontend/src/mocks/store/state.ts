import type { Identity } from '../../lib/api/demo';
import type {
  Instrument,
  Onboarding,
  Pool,
  PoolProposal,
  Profile,
  Role,
  SwapPreparation,
  SwapQuote,
  SwapRequest,
} from '../../lib/api/types';
import { DECIMAL_SCALE, DomainError, toDecimal } from '../../lib/api/types';
import {
  seedIdentities,
  seedInstruments,
  seedPools,
  seedProposals,
  SYNCHRONIZER,
  VENUE_OPERATOR,
  VENUE_PARTICIPANT,
} from '../data';

/** Daml `Decimal` renders with a fixed scale and holds no infinities. */
export function decimal(value: number): string {
  try {
    return toDecimal(value);
  } catch {
    throw new DomainError('Amount is out of range', 'VALIDATION');
  }
}

/** Rounds toward zero, so the demo never promises more than the ledger gives. */
export function floorDecimal(value: number): string {
  const scale = 10 ** DECIMAL_SCALE;
  return decimal(Math.floor(value * scale) / scale);
}

/** Rejects a blank, negative or non-finite amount the way the ledger would. */
export function positive(raw: string): number {
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(value) || value <= 0) {
    throw new DomainError('Amount must be a number greater than zero', 'VALIDATION');
  }
  return value;
}

/**
 * Quotes and preparations belong to the account that created them. The owner
 * is kept here and never leaves the mock, so the public API needs no actor
 * argument, and one account can never spend another's preparation.
 */
interface Owned<T> {
  owner: string;
  value: T;
  /** Set once the item has been used, so it cannot be spent twice. */
  spentBy: string | null;
}


export interface DemoState {
  /** Issuer of every contract the demo confirms, as the operator's party. */
  venueOperatorParty: string;
  /** The synchronizer a prepared party would be registered on. */
  synchronizerId: string;
  /** The participant that would host a prepared party. */
  participantId: string;
  identities: Identity[];
  instruments: Instrument[];
  pools: Pool[];
  proposals: PoolProposal[];
  onboardings: Onboarding[];
  quotes: Owned<SwapQuote>[];
  preparations: Owned<SwapPreparation>[];
  swapRequests: SwapRequest[];
  counter: number;
}

export function createDemoState(): DemoState {
  const state: DemoState = {
    venueOperatorParty: VENUE_OPERATOR,
    synchronizerId: SYNCHRONIZER,
    participantId: VENUE_PARTICIPANT,
    identities: structuredClone(seedIdentities),
    instruments: structuredClone(seedInstruments),
    pools: structuredClone(seedPools),
    proposals: structuredClone(seedProposals),
    onboardings: [],
    quotes: [],
    preparations: [],
    swapRequests: [],
    counter: 0,
  };
  return state;
}


export function nextId(state: DemoState, prefix: string): string {
  state.counter += 1;
  return `${prefix}-${String(state.counter).padStart(4, '0')}`;
}

export function now(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------- the caller

/** Unknown accounts are rejected outright; the demo never invents a party. */
export function requireIdentity(state: DemoState, accountId: string): Identity {
  const identity = state.identities.find((candidate) => candidate.accountId === accountId);
  if (!identity) throw new DomainError('Account not found', 'NOT_FOUND');
  return identity;
}

/** The party is the one a confirmed onboarding registered, never a guess. */
export function profileOf(state: DemoState, accountId: string): Profile {
  const { displayName, role } = requireIdentity(state, accountId);
  const own = state.onboardings.find((candidate) => candidate.accountId === accountId);
  const party = own?.party;
  return {
    accountId,
    displayName,
    role,
    partyId: party?.confirmed === true ? party.partyId : null,
  };
}

export function requireRole(state: DemoState, accountId: string, role: Role): Identity {
  const identity = requireIdentity(state, accountId);
  if (identity.role !== role) {
    throw new DomainError('This account cannot perform that operation', 'FORBIDDEN');
  }
  return identity;
}


export function locate(state: DemoState, onboardingId: string): Onboarding {
  const found = state.onboardings.find((candidate) => candidate.id === onboardingId);
  if (!found) throw new DomainError('Onboarding not found', 'NOT_FOUND');
  return found;
}

export const QUOTE_TTL_MS = 120_000;
export const SETTLEMENT_TTL_MS = 900_000;
