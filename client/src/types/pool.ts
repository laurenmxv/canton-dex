/**
 * A pool in the venue's current catalogue.
 *
 * Presence here means the pool exists and an operator may approve access to
 * it. It says nothing about whether a given trader may trade it: that follows
 * from their own confirmed access on the ledger.
 */
export interface PoolSummary {
  poolId: string;
  name: string;
}

/** A Canton instrument: the admin that issues it, and that admin's own id for it. */
export interface InstrumentId {
  admin: string;
  id: string;
}

/** An account the pool holds an instrument in: the dvo owns it, the venue operator provides it. */
export interface PoolAccount {
  owner: string;
  provider: string;
  id: string;
}

/** A pair and a whole-bps fee. The dvo configures the rest on acceptance. */
export interface PoolProposalTerms {
  dvo: string;
  baseInstrumentId: InstrumentId;
  quoteInstrumentId: InstrumentId;
  feeBps: string;
}

/**
 * What a pool is made of, as the ledger confirmed it.
 *
 * Every amount is a decimal string, as the ledger stores it. None of them is
 * parsed into a JavaScript number anywhere in this client: a `Decimal` carries
 * 28 integer and 10 fractional digits, which a double cannot hold. A pool
 * starts empty; `initialRatio` is the quote per base its first deposit uses.
 */
export interface PoolTerms extends PoolProposalTerms {
  baseAccount: PoolAccount;
  quoteAccount: PoolAccount;
  lpTokenInstrumentId: InstrumentId;
  baseReserve: string;
  quoteReserve: string;
  lpTokenSupply: string;
  initialRatio: string;
}

/**
 * What an operator proposes. The venue assigns the authority, the factory and
 * the owners, so none of them is a parameter here.
 */
export interface CreatePoolProposal {
  name: string;
  baseInstrumentId: InstrumentId;
  quoteInstrumentId: InstrumentId;
  feeBps: string;
}

/**
 * Where a proposal stands.
 *
 * `UNRESOLVED` is not a failure: the venue has not seen the outcome yet.
 * `FAILED` is, and it is final: the command was rejected, and `error` says
 * why. A `PENDING` proposal can carry an error too, from a reconciliation or a
 * refused withdrawal, without losing anything it already holds.
 */
export type PoolProposalStatus =
  | 'SUBMITTING'
  | 'PENDING'
  | 'CREATED'
  | 'REJECTED'
  | 'WITHDRAWN'
  | 'UNRESOLVED'
  | 'FAILED';

export interface PoolProposal {
  proposalId: string;
  name: string;
  settings: PoolProposalTerms;
  status: PoolProposalStatus;
  createdAt: string;
  updatedAt: string;
  proposedBy: string;
  proposalCid: string | null;
  factoryId: string;
  poolId: string | null;
  updateId: string | null;
  error: string | null;
}

/** A pool as it exists on the ledger, with the contracts that hold it. */
export interface PoolDetail {
  poolId: string;
  name: string;
  settings: PoolTerms;
  configId: string;
  stateId: string;
  packageId: string;
  createdAt: string | null;
  updatedAt: string;
}

/**
 * An instrument the venue registers, as a proposal may choose it.
 *
 * `admin` and `id` name it together: two administrators may register the same
 * `symbol`, and the same `id` under it. `decimals` is the precision the
 * instrument accepts.
 */
export interface RegisteredInstrument {
  admin: string;
  id: string;
  symbol: string;
  decimals: number;
}

/**
 * What a proposal is built against.
 *
 * The caller chooses none of the parties, and takes its pair out of
 * `instruments`. An instrument outside that catalogue is refused.
 */
export interface PoolCreationOptions {
  factoryId: string;
  dvo: string;
  venueOperator: string;
  instruments: readonly RegisteredInstrument[];
}

/** One confirmed swap, normalized into the pool's base and quote instruments. */
export interface MarketTrade {
  swapId: string;
  direction: 'BaseToQuote' | 'QuoteToBase';
  baseAmount: string;
  quoteAmount: string;
  /** Quote units per base unit. */
  executionPrice: string;
  settledAt: string;
}

/** One non-empty UTC hour of confirmed execution history. */
export interface MarketCandle {
  startedAt: string;
  open: string;
  high: string;
  low: string;
  close: string;
  baseVolume: string;
  quoteVolume: string;
  tradeCount: number;
}

/**
 * A current reserve price and a rolling 24-hour confirmed-trade window.
 *
 * All financial values remain decimal strings. Empty hours are omitted,
 * `spotPrice` is null for an empty pool, and change is null until two trades
 * establish both boundaries.
 */
export interface MarketData {
  poolId: string;
  asOf: string;
  interval: '1h';
  spotPrice: string | null;
  baseVolume24h: string;
  quoteVolume24h: string;
  priceChangePercent24h: string | null;
  candles: readonly MarketCandle[];
  recentTrades: readonly MarketTrade[];
}

export interface MarketDataQuery {
  interval?: '1h';
  /** Positive, with a venue maximum of 24. */
  candleLimit?: number;
  /** Positive, with a venue maximum of 20. */
  recentLimit?: number;
}
