import type {
  InstrumentId,
  LiquidityActivity,
  LiquidityRequest,
  LpPosition,
  RecoveryEffect,
  TokenBalance,
} from '../../lib/api/types';
import { decimalText, formatDecimal, formatExact, multiplyDecimals, parseDecimal } from '../../lib/decimal';
import { instrumentLabel } from '../swap/terms';

const LP_DECIMALS = 10;

/**
 * LP amounts read "LP": each one is shown beside the pool it belongs to, and a
 * pool's LP instrument id is an opaque identifier rather than a name.
 */
const LP = 'LP';

function lp(value: string): string {
  return `${formatExact(value)} ${LP}`;
}

/** The redeemable LP as a balance, so a withdrawal is validated like any other spend. */
export function lpBalance(position: LpPosition): TokenBalance {
  return {
    instrument: position.lpInstrument,
    symbol: LP,
    decimals: LP_DECIMALS,
    available: position.availableLp,
    locked: position.allocatedLp,
    total: position.totalLp,
  };
}

export function sharePercent(share: string): string {
  const fraction = parseDecimal(share);
  if (!fraction) return share;
  const percent = decimalText(multiplyDecimals(fraction, { units: 100n, scale: 0 }));
  return `${formatDecimal(percent, { minFractionDigits: 0, maxFractionDigits: 4 })}%`;
}

function amounts(balances: readonly TokenBalance[]) {
  return (value: string, instrument: InstrumentId) =>
    `${formatExact(value)} ${instrumentLabel(balances, instrument)}`;
}

/** What a request offered, and its settled outcome or else the signed floor. */
export function requestAmounts(
  request: LiquidityRequest,
  balances: readonly TokenBalance[],
): { offered: string; outcome: string } {
  const show = amounts(balances);
  if (request.kind === 'DEPOSIT') {
    const { terms, result } = request;
    return {
      offered: `up to ${show(terms.maxBaseAmount, terms.baseInstrument)} + ${show(terms.maxQuoteAmount, terms.quoteInstrument)}`,
      outcome: result ? `${lp(result.actualLpOut)} minted` : `minimum ${lp(terms.minLpOut)}`,
    };
  }
  const { terms, result } = request;
  return {
    offered: lp(terms.lpAmount),
    outcome: result
      ? `${show(result.actualBaseOut, terms.baseInstrument)} + ${show(result.actualQuoteOut, terms.quoteInstrument)}`
      : `minimum ${show(terms.minBaseOut, terms.baseInstrument)} + ${show(terms.minQuoteOut, terms.quoteInstrument)}`,
  };
}

/** The settled amounts, as the ledger recorded them. Empty until settlement. */
export function settledItems(
  request: LiquidityRequest,
  balances: readonly TokenBalance[],
): { label: string; value: string }[] {
  const show = amounts(balances);
  if (request.kind === 'DEPOSIT') {
    const { terms, result } = request;
    if (!result) return [];
    return [
      {
        label: 'Accepted',
        value: `${show(result.actualBaseIn, terms.baseInstrument)} + ${show(result.actualQuoteIn, terms.quoteInstrument)}`,
      },
      {
        label: 'Refunded',
        value: `${show(result.actualBaseRefund, terms.baseInstrument)} + ${show(result.actualQuoteRefund, terms.quoteInstrument)}`,
      },
      { label: 'LP minted', value: lp(result.actualLpOut) },
    ];
  }
  const { terms, result } = request;
  if (!result) return [];
  return [
    { label: 'LP burned', value: lp(result.actualLpBurned) },
    {
      label: 'Paid out',
      value: `${show(result.actualBaseOut, terms.baseInstrument)} + ${show(result.actualQuoteOut, terms.quoteInstrument)}`,
    },
  ];
}

/** What an effect's instrument reads as: "LP" for the request's own LP, otherwise its symbol. */
export function effectUnit(
  effect: RecoveryEffect,
  balances: readonly TokenBalance[],
  lpInstrument: InstrumentId,
): string {
  const { admin, id } = effect.instrument;
  return admin === lpInstrument.admin && id === lpInstrument.id
    ? LP
    : instrumentLabel(balances, effect.instrument);
}

/** A permission effect carries no amount: it only withdraws the pool's right to pay. */
export function recoveryLine(
  effect: RecoveryEffect,
  balances: readonly TokenBalance[],
  lpInstrument: InstrumentId,
): string {
  const unit = effectUnit(effect, balances, lpInstrument);
  return effect.kind === 'RETURN_FUNDS'
    ? `Returns ${formatExact(effect.amount)} ${unit}`
    : `Releases ${unit} receipt permission (no funds returned)`;
}

const FINAL = new Set<LiquidityRequest['status']>(['SETTLED', 'RECOVERED', 'FAILED']);

/** Statuses that say nothing yet about whether a sent submission took effect. */
const UNCONFIRMED = new Set<LiquidityRequest['status']>(['PREPARED', 'SUBMITTING', 'UNRESOLVED']);

export function hasOutstanding(page: LiquidityActivity<LiquidityRequest>): boolean {
  return page.items.some((request) => !FINAL.has(request.status));
}

/** True once a sent request has a status past its submission, or there is none to wait for. */
export function resolved(
  page: LiquidityActivity<LiquidityRequest> | undefined,
  requestId: string | undefined,
): boolean {
  if (requestId === undefined) return true;
  const request = page?.items.find((item) => item.requestId === requestId);
  return request !== undefined && !UNCONFIRMED.has(request.status);
}

/** Every request's status on a page as one value; a change means holdings may have moved. */
export function lifecycle(page: LiquidityActivity<LiquidityRequest> | undefined): string | undefined {
  return page?.items.map((request) => `${request.requestId}:${request.status}`).join('|');
}
