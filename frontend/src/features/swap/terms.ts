import {
  compareDecimals,
  formatDecimal,
  fractionDigits,
  isLedgerDecimal,
  isZero,
  parseDecimal,
} from '../../lib/decimal';
import type {
  InstrumentId,
  PoolDetail,
  PoolSummary,
  SwapDirection,
  TokenBalance,
} from '../../lib/api/types';

/** Pools the trader may actually trade: in the catalogue, and granted on the ledger. */
export function eligiblePools(
  catalogue: readonly PoolSummary[],
  confirmedPoolIds: readonly string[],
): PoolSummary[] {
  return catalogue.filter((pool) => confirmedPoolIds.includes(pool.poolId));
}

/** Which instrument is paid and which is received, for one direction. */
export function sidesOf(
  pool: PoolDetail,
  direction: SwapDirection,
): { input: InstrumentId; output: InstrumentId } {
  const { baseInstrumentId, quoteInstrumentId } = pool.settings;
  return direction === 'BaseToQuote'
    ? { input: baseInstrumentId, output: quoteInstrumentId }
    : { input: quoteInstrumentId, output: baseInstrumentId };
}

/** A token is its administrator and that administrator's own id, never its symbol alone. */
export function balanceOf(
  balances: readonly TokenBalance[],
  instrument: InstrumentId,
): TokenBalance | undefined {
  return balances.find(
    (balance) =>
      balance.instrument.admin === instrument.admin && balance.instrument.id === instrument.id,
  );
}

/**
 * What to call an instrument on screen.
 *
 * The symbol comes from a balance where the trader holds one. Otherwise the
 * administrator's own id stands in, which is what identifies it anyway.
 */
export function instrumentLabel(
  balances: readonly TokenBalance[],
  instrument: InstrumentId,
): string {
  return balanceOf(balances, instrument)?.symbol ?? instrument.id;
}

/**
 * Why this amount cannot be sent, or undefined when it can.
 *
 * Everything is compared as a decimal string. A balance carries more digits
 * than a double holds, so none of this goes through a number.
 */
export function amountProblem(
  raw: string,
  balance: TokenBalance | undefined,
  symbol: string,
): string | undefined {
  const text = raw.trim();
  if (text === '') return 'Enter an amount.';
  // Only what the ledger can carry is checked here. How much a pool will
  // price is the venue's answer, not this form's.
  if (!isLedgerDecimal(text)) {
    return 'Use a plain decimal amount, with no sign, spaces or exponent.';
  }
  const amount = parseDecimal(text)!;
  if (isZero(amount)) return 'Enter an amount above zero.';
  if (!balance) return `You hold no ${symbol}.`;
  if (fractionDigits(amount) > balance.decimals) {
    return `${symbol} has ${balance.decimals} decimal places.`;
  }
  const available = parseDecimal(balance.available);
  if (available && compareDecimals(amount, available) > 0) {
    return `You have ${formatDecimal(balance.available)} ${symbol} available.`;
  }
  return undefined;
}

/** Why this slippage cannot be sent, or undefined when it can. */
export function slippageProblem(raw: string, maxBps: number): string | undefined {
  const text = raw.trim();
  if (!/^\d{1,4}$/.test(text)) return `Enter whole basis points, from 0 to ${maxBps}.`;
  return Number(text) > maxBps ? `Enter whole basis points, from 0 to ${maxBps}.` : undefined;
}
