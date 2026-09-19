import type { Identity } from '../lib/api/demo';
import type { Instrument, Pool, PoolApproval, PoolProposal } from '../lib/api/types';

/** Fingerprint suffix Canton appends to party hints. Shortened for readability. */
const FP = '1220f4c1a9';

export const ACCOUNT_ALICE = 'acc-trader-alice';
export const ACCOUNT_BOB = 'acc-trader-bob';
export const ACCOUNT_OPERATOR = 'acc-operator';

const VENUE_GOVERNANCE = `venue-governance::${FP}b21`;
const LP_TOKEN_ISSUER = `lp-issuer::${FP}c07`;
const POOL_HOLDINGS = `pool-holdings::${FP}d4e`;
export const VENUE_OPERATOR = `venue-operator::${FP}a13`;
export const SYNCHRONIZER = `global-domain::${FP}d01`;
export const VENUE_PARTICIPANT = `venue-participant::${FP}p02`;

export const APPROVER_PARTIES = {
  venueGovernance: VENUE_GOVERNANCE,
  lpTokenIssuer: LP_TOKEN_ISSUER,
  poolHoldings: POOL_HOLDINGS,
} as const;

export const seedIdentities: Identity[] = [
  {
    accountId: ACCOUNT_ALICE,
    displayName: 'Alice Carter',
    role: 'TRADER',
    fixturePartyId: `alice-carter::${FP}77a`,
  },
  {
    accountId: ACCOUNT_BOB,
    displayName: 'Bob Sullivan',
    role: 'TRADER',
    fixturePartyId: `bob-sullivan::${FP}88b`,
  },
  {
    accountId: ACCOUNT_OPERATOR,
    displayName: 'Venue Operations',
    role: 'OPERATOR',
    fixturePartyId: VENUE_OPERATOR,
  },
];

export const seedInstruments: Instrument[] = [
  { id: 'inst-usdc', symbol: 'USDC', admin: `usdc-admin::${FP}e11` },
  { id: 'inst-eurc', symbol: 'EURC', admin: `eurc-admin::${FP}e22` },
  { id: 'inst-cc', symbol: 'CC', admin: `cc-admin::${FP}e33` },
  { id: 'inst-tbill', symbol: 'TBILL', admin: `tbill-admin::${FP}e44` },
];

export const seedPools: Pool[] = [
  {
    poolId: 'pool-usdc-eurc',
    name: 'USDC / EURC',
    baseInstrumentId: 'inst-usdc',
    quoteInstrumentId: 'inst-eurc',
    feeBps: 30,
    baseReserve: '4200000.0000000000',
    quoteReserve: '3885000.0000000000',
    lpTokenSupply: '4040111.3801000000',
    createdAt: '2026-08-04T09:12:00Z',
  },
  {
    poolId: 'pool-cc-usdc',
    name: 'CC / USDC',
    baseInstrumentId: 'inst-cc',
    quoteInstrumentId: 'inst-usdc',
    feeBps: 5,
    baseReserve: '18500000.0000000000',
    quoteReserve: '2405000.0000000000',
    lpTokenSupply: '6670382.0895000000',
    createdAt: '2026-08-21T14:40:00Z',
  },
];

function approvals(approved: Array<keyof typeof APPROVER_PARTIES>): PoolApproval[] {
  return (Object.keys(APPROVER_PARTIES) as Array<keyof typeof APPROVER_PARTIES>).map(
    (approver) => ({
      approver,
      party: APPROVER_PARTIES[approver],
      approved: approved.includes(approver),
      approvedAt: approved.includes(approver) ? '2026-09-15T11:02:00Z' : null,
    }),
  );
}

export const seedProposals: PoolProposal[] = [
  {
    proposalId: 'prop-tbill-usdc',
    name: 'TBILL / USDC',
    settings: {
      baseInstrumentId: 'inst-tbill',
      quoteInstrumentId: 'inst-usdc',
      feeBps: 10,
      baseReserve: '750000.0000000000',
      quoteReserve: '748125.0000000000',
      lpTokenSupply: '749062.0000000000',
    },
    approvals: approvals(['venueGovernance']),
    status: 'AWAITING_APPROVALS',
    createdBy: ACCOUNT_OPERATOR,
    createdAt: '2026-09-15T10:55:00Z',
    poolId: null,
  },
];

/**
 * Bob has applied and is waiting, so the operator queue is never empty. It is a
 * historical row: it carries document references rather than document metadata,
 * and its party was held by the participant instead of being registered.
 */
export const seedOnboardingApplication = {
  accountId: ACCOUNT_BOB,
  legalName: 'Sullivan Capital Partners LLC',
  countryCode: 'US',
  documentReferences: ['doc://kyc/sullivan-capital/incorporation', 'doc://kyc/sullivan-capital/ubo'],
  createdAt: '2026-09-16T08:30:00Z',
};
