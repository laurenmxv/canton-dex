import type { CreateProposalInput, Pool, PoolApprover, PoolProposal } from '../../lib/api/types';
import { BPS_SCALE, DomainError } from '../../lib/api/types';
import { APPROVER_PARTIES } from '../data';
import { decimal, floorDecimal, nextId, now, positive, requireRole, type DemoState } from './state';

// --------------------------------------------------------------------- pools

export function createProposal(
  state: DemoState,
  accountId: string,
  input: CreateProposalInput,
): PoolProposal {
  requireRole(state, accountId, 'OPERATOR');
  for (const instrumentId of [input.baseInstrumentId, input.quoteInstrumentId]) {
    if (!state.instruments.some((instrument) => instrument.id === instrumentId)) {
      throw new DomainError(`Unknown instrument ${instrumentId}`, 'VALIDATION');
    }
  }
  if (input.baseInstrumentId === input.quoteInstrumentId) {
    throw new DomainError('Base and quote instruments must differ', 'VALIDATION');
  }
  if (!(Number.isFinite(input.feeBps) && input.feeBps >= 0 && input.feeBps < BPS_SCALE)) {
    throw new DomainError(`Fee must be between 0 and ${BPS_SCALE} bps`, 'VALIDATION');
  }
  const baseReserve = positive(input.baseReserve);
  const quoteReserve = positive(input.quoteReserve);

  const proposal: PoolProposal = {
    proposalId: nextId(state, 'prop'),
    name: input.name,
    settings: {
      baseInstrumentId: input.baseInstrumentId,
      quoteInstrumentId: input.quoteInstrumentId,
      feeBps: input.feeBps,
      baseReserve: decimal(baseReserve),
      quoteReserve: decimal(quoteReserve),
      // The venue derives initial liquidity; the operator never supplies it.
      lpTokenSupply: floorDecimal(Math.sqrt(baseReserve * quoteReserve)),
    },
    approvals: (Object.keys(APPROVER_PARTIES) as PoolApprover[]).map((approver) => ({
      approver,
      party: APPROVER_PARTIES[approver],
      approved: false,
      approvedAt: null,
    })),
    status: 'AWAITING_APPROVALS',
    createdBy: accountId,
    createdAt: now(),
    poolId: null,
  };
  state.proposals.push(proposal);
  return proposal;
}

export function findProposal(state: DemoState, proposalId: string): PoolProposal {
  const found = state.proposals.find((candidate) => candidate.proposalId === proposalId);
  if (!found) throw new DomainError('Proposal not found', 'NOT_FOUND');
  return found;
}

export function approveProposal(
  state: DemoState,
  proposalId: string,
  approver: PoolApprover,
): PoolProposal {
  const proposal = findProposal(state, proposalId);
  if (proposal.status === 'CREATED') {
    throw new DomainError('Pool is already created', 'CONFLICT');
  }
  const approval = proposal.approvals.find((candidate) => candidate.approver === approver);
  if (!approval) throw new DomainError('Unknown approver', 'NOT_FOUND');
  if (approval.approved) throw new DomainError('Approval is not pending', 'CONFLICT');
  approval.approved = true;
  approval.approvedAt = now();
  if (proposal.approvals.every((candidate) => candidate.approved)) proposal.status = 'READY';
  return proposal;
}

/** Only the operator that proposed a pool may ask the venue to create it. */
export function requestPoolCreation(
  state: DemoState,
  accountId: string,
  proposalId: string,
): PoolProposal {
  requireRole(state, accountId, 'OPERATOR');
  const proposal = findProposal(state, proposalId);
  if (proposal.createdBy !== accountId) {
    throw new DomainError('Another operator proposed this pool', 'FORBIDDEN');
  }
  if (proposal.status === 'CREATED') {
    throw new DomainError('Pool is already created', 'CONFLICT');
  }
  if (!proposal.approvals.every((candidate) => candidate.approved)) {
    throw new DomainError('Missing pool approvals', 'CONFLICT');
  }
  const pool: Pool = {
    poolId: nextId(state, 'pool'),
    name: proposal.name,
    baseInstrumentId: proposal.settings.baseInstrumentId,
    quoteInstrumentId: proposal.settings.quoteInstrumentId,
    feeBps: proposal.settings.feeBps,
    baseReserve: proposal.settings.baseReserve,
    quoteReserve: proposal.settings.quoteReserve,
    lpTokenSupply: proposal.settings.lpTokenSupply,
    createdAt: now(),
  };
  state.pools.push(pool);
  proposal.status = 'CREATED';
  proposal.poolId = pool.poolId;
  return proposal;
}

