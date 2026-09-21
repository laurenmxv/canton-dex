import type { FieldErrors, Resolver } from 'react-hook-form';
import { BPS_SCALE } from '../../lib/api/types';
import type { CreatePoolProposal, PoolCreationOptions } from '../../lib/api/types';
import { isLedgerDecimal } from '../../lib/decimal';

/**
 * What the operator fills in, before it becomes a proposal.
 *
 * Every amount stays a string all the way to the wire. A `Decimal` carries 28
 * integer and 10 fractional digits, which a JavaScript number cannot hold, so
 * nothing here parses one to validate or to send it.
 */
export interface ProposalDraft {
  name: string;
  baseAdmin: string;
  baseId: string;
  quoteAdmin: string;
  quoteId: string;
  feeBps: string;
  baseReserve: string;
  quoteReserve: string;
  lpTokenSupply: string;
  baseAccountId: string;
  quoteAccountId: string;
  lpTokenId: string;
}

export type DraftField = keyof ProposalDraft;

/** The venue's own bounds on the text a proposal carries. */
const MAX_IDENTIFIER = 128;
const MAX_PARTY = 255;
const MAX_NAME = 120;
/**
 * A control character, as the venue's own `Character.isISOControl` reads one:
 * C0 and DEL, and the C1 range above them.
 */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function firstAdmin(options: PoolCreationOptions | undefined): string {
  return options?.instrumentAdmins[0]?.partyId ?? '';
}

export function emptyDraft(options?: PoolCreationOptions): ProposalDraft {
  const admin = firstAdmin(options);
  return {
    name: '',
    baseAdmin: admin,
    baseId: '',
    quoteAdmin: admin,
    quoteId: '',
    feeBps: '30',
    baseReserve: '',
    quoteReserve: '',
    lpTokenSupply: '',
    baseAccountId: '',
    quoteAccountId: '',
    lpTokenId: '',
  };
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * What the identifiers become while the operator has not written their own.
 *
 * They are suggestions, not defaults the form hides: the fields carry them and
 * stay editable.
 */
export function suggestedIds(draft: ProposalDraft): Pick<
  ProposalDraft,
  'name' | 'baseAccountId' | 'quoteAccountId' | 'lpTokenId'
> {
  const base = draft.baseId.trim();
  const quote = draft.quoteId.trim();
  const pair = base && quote ? `${slug(base)}-${slug(quote)}` : '';
  return {
    name: base && quote ? `${base} / ${quote}` : '',
    baseAccountId: pair ? `${pair}-base` : '',
    quoteAccountId: pair ? `${pair}-quote` : '',
    lpTokenId: base && quote ? `LP-${base.toUpperCase()}-${quote.toUpperCase()}` : '',
  };
}

function amountError(raw: string, what: string): string | undefined {
  const value = raw.trim();
  if (value === '') return `${what} is required`;
  if (!isLedgerDecimal(value)) return `${what} must be a decimal with up to 10 fractional digits`;
  if (!/[1-9]/.test(value)) return `${what} must be greater than zero`;
  return undefined;
}

function textError(raw: string, what: string, max: number): string | undefined {
  const value = raw.trim();
  if (value === '') return `${what} is required`;
  if (value.length > max) return `${what} must be at most ${max} characters`;
  if (CONTROL.test(value)) return `${what} carries a character the venue refuses`;
  return undefined;
}

function feeError(raw: string): string | undefined {
  const value = raw.trim();
  if (value === '') return 'Fee is required';
  if (!isLedgerDecimal(value)) return 'Fee must be a decimal with up to 10 fractional digits';
  // The integer part is at most five digits here, so this comparison is exact.
  const whole = Number(value.split('.')[0]);
  // Basis points are exclusive of the scale, which is a whole fee.
  if (whole >= BPS_SCALE) return `Fee must be below ${BPS_SCALE} bps`;
  return undefined;
}

/** The venue's own bounds, checked here so a request is not sent to be refused. */
export function draftErrors(draft: ProposalDraft): Partial<Record<DraftField, string>> {
  const errors: Partial<Record<DraftField, string>> = {};
  const set = (field: DraftField, error: string | undefined) => {
    if (error) errors[field] = error;
  };

  set('name', textError(draft.name, 'Name', MAX_NAME));
  set('baseAdmin', textError(draft.baseAdmin, 'Base admin', MAX_PARTY));
  set('baseId', textError(draft.baseId, 'Base instrument', MAX_IDENTIFIER));
  set('quoteAdmin', textError(draft.quoteAdmin, 'Quote admin', MAX_PARTY));
  set('quoteId', textError(draft.quoteId, 'Quote instrument', MAX_IDENTIFIER));
  set('feeBps', feeError(draft.feeBps));
  set('baseReserve', amountError(draft.baseReserve, 'Base reserve'));
  set('quoteReserve', amountError(draft.quoteReserve, 'Quote reserve'));
  set('lpTokenSupply', amountError(draft.lpTokenSupply, 'LP supply'));
  set('baseAccountId', textError(draft.baseAccountId, 'Base account', MAX_IDENTIFIER));
  set('quoteAccountId', textError(draft.quoteAccountId, 'Quote account', MAX_IDENTIFIER));
  set('lpTokenId', textError(draft.lpTokenId, 'LP token', MAX_IDENTIFIER));

  // An instrument is its admin and its id together, so only both being equal
  // is the same instrument on both sides of the pair.
  if (
    !errors.baseId &&
    !errors.quoteId &&
    draft.baseAdmin === draft.quoteAdmin &&
    draft.baseId.trim() === draft.quoteId.trim()
  ) {
    errors.quoteId = 'The quote instrument must differ from the base instrument';
  }
  return errors;
}

/**
 * The same rules, as React Hook Form reads them.
 *
 * The rules stay in `draftErrors`. They are the venue's own bounds, they are
 * covered field by field, and a second copy written against a schema library
 * would be free to drift from what the backend refuses. This only translates
 * the shape.
 */
export const proposalResolver: Resolver<ProposalDraft> = (values) => {
  const found = draftErrors(values);
  const errors: FieldErrors<ProposalDraft> = {};
  for (const field of Object.keys(found) as DraftField[]) {
    errors[field] = { type: 'venue', message: found[field] };
  }
  return Object.keys(errors).length === 0 ? { values, errors: {} } : { values: {}, errors };
};

/** The request body, trimmed, with nothing the venue assigns for itself. */
export function toProposal(draft: ProposalDraft): CreatePoolProposal {
  return {
    name: draft.name.trim(),
    baseInstrumentId: { admin: draft.baseAdmin.trim(), id: draft.baseId.trim() },
    quoteInstrumentId: { admin: draft.quoteAdmin.trim(), id: draft.quoteId.trim() },
    baseAccountId: draft.baseAccountId.trim(),
    quoteAccountId: draft.quoteAccountId.trim(),
    lpTokenId: draft.lpTokenId.trim(),
    feeBps: draft.feeBps.trim(),
    baseReserve: draft.baseReserve.trim(),
    quoteReserve: draft.quoteReserve.trim(),
    lpTokenSupply: draft.lpTokenSupply.trim(),
  };
}
