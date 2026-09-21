import type { FieldErrors, Resolver } from 'react-hook-form';
import { BPS_SCALE } from '../../lib/api/types';
import type { CreatePoolProposal, InstrumentId, RegisteredInstrument } from '../../lib/api/types';
import { isLedgerDecimal } from '../../lib/decimal';

/**
 * What the operator fills in, before it becomes a proposal.
 *
 * `base` and `quote` are keys into the venue's registered instruments, not text
 * the operator writes. Every amount stays a string all the way to the wire. A
 * `Decimal` carries 28 integer and 10 fractional digits, which a JavaScript
 * number cannot hold, so nothing here parses one to validate or to send it.
 */
export interface ProposalDraft {
  name: string;
  base: string;
  quote: string;
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
const MAX_NAME = 120;
/**
 * A control character, as the venue's own `Character.isISOControl` reads one:
 * C0 and DEL, and the C1 range above them.
 */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * What a listbox value is: one catalogue row, named by both its parts.
 *
 * The key is only ever looked up again, never taken apart, so the venue's own
 * rule against a control character in either part is what keeps two rows from
 * sharing a key rather than something this file has to assume.
 */
export function instrumentKey({ admin, id }: InstrumentId): string {
  return `${admin}\n${id}`;
}

/** The catalogue entry a key names, while the venue still registers it. */
export function registeredInstrument(
  catalog: readonly RegisteredInstrument[],
  key: string,
): RegisteredInstrument | undefined {
  return catalog.find((instrument) => instrumentKey(instrument) === key);
}

/** How one instrument reads, before anything is done about two that read alike. */
export function instrumentReading(instrument: RegisteredInstrument): string {
  return instrument.symbol === instrument.id
    ? instrument.symbol
    : `${instrument.symbol} · ${instrument.id}`;
}

/**
 * The catalogue as a listbox offers it.
 *
 * Two administrators may register the same symbol, and the same id under it, so
 * a row another row reads the same as carries its administrator in full. The
 * value is the whole identity, which is what the operator is choosing.
 */
export function instrumentChoices(
  catalog: readonly RegisteredInstrument[],
): { value: string; label: string }[] {
  const texts = catalog.map(instrumentReading);
  const uses = new Map<string, number>();
  for (const text of texts) uses.set(text, (uses.get(text) ?? 0) + 1);
  return catalog.map((instrument, at) => ({
    value: instrumentKey(instrument),
    label: uses.get(texts[at]!) === 1 ? texts[at]! : `${texts[at]} (${instrument.admin})`,
  }));
}

export function emptyDraft(): ProposalDraft {
  return {
    name: '',
    base: '',
    quote: '',
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
 * stay editable. They follow the instrument identifiers the ledger settles on,
 * not the symbols two administrators may share.
 */
export function suggestedIds(
  draft: ProposalDraft,
  catalog: readonly RegisteredInstrument[],
): Pick<ProposalDraft, 'name' | 'baseAccountId' | 'quoteAccountId' | 'lpTokenId'> {
  const base = registeredInstrument(catalog, draft.base)?.id ?? '';
  const quote = registeredInstrument(catalog, draft.quote)?.id ?? '';
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

/** An instrument is only usable while the venue still registers it. */
function instrumentError(
  key: string,
  catalog: readonly RegisteredInstrument[],
  what: string,
): string | undefined {
  if (key === '') return `${what} is required`;
  if (!registeredInstrument(catalog, key)) return `${what} is no longer registered`;
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
export function draftErrors(
  draft: ProposalDraft,
  catalog: readonly RegisteredInstrument[],
): Partial<Record<DraftField, string>> {
  const errors: Partial<Record<DraftField, string>> = {};
  const set = (field: DraftField, error: string | undefined) => {
    if (error) errors[field] = error;
  };

  set('name', textError(draft.name, 'Name', MAX_NAME));
  set('base', instrumentError(draft.base, catalog, 'Base instrument'));
  set('quote', instrumentError(draft.quote, catalog, 'Quote instrument'));
  set('feeBps', feeError(draft.feeBps));
  set('baseReserve', amountError(draft.baseReserve, 'Base reserve'));
  set('quoteReserve', amountError(draft.quoteReserve, 'Quote reserve'));
  set('lpTokenSupply', amountError(draft.lpTokenSupply, 'LP supply'));
  set('baseAccountId', textError(draft.baseAccountId, 'Base account', MAX_IDENTIFIER));
  set('quoteAccountId', textError(draft.quoteAccountId, 'Quote account', MAX_IDENTIFIER));
  set('lpTokenId', textError(draft.lpTokenId, 'LP token', MAX_IDENTIFIER));

  // A key carries the administrator and the identifier together, so two equal
  // keys are the same instrument on both sides of the pair, and the same id
  // from two administrators is a pair the venue accepts.
  if (!errors.base && !errors.quote && draft.base === draft.quote) {
    errors.quote = 'The quote instrument must differ from the base instrument';
  }
  return errors;
}

/**
 * The same rules, as React Hook Form reads them.
 *
 * The rules stay in `draftErrors`. They are the venue's own bounds, they are
 * covered field by field, and a second copy written against a schema library
 * would be free to drift from what the backend refuses. This only translates
 * the shape, and binds the catalogue the pair is checked against.
 */
export function proposalResolver(
  catalog: readonly RegisteredInstrument[],
): Resolver<ProposalDraft> {
  return (values) => {
    const found = draftErrors(values, catalog);
    const errors: FieldErrors<ProposalDraft> = {};
    for (const field of Object.keys(found) as DraftField[]) {
      errors[field] = { type: 'venue', message: found[field] };
    }
    return Object.keys(errors).length === 0 ? { values, errors: {} } : { values: {}, errors };
  };
}

/** A draft whose pair the venue registers, holding the two rows it names. */
export interface ProposedPool {
  draft: ProposalDraft;
  base: RegisteredInstrument;
  quote: RegisteredInstrument;
}

/**
 * The draft as something that can be proposed, or null while either side names
 * no registered instrument.
 *
 * Resolving here rather than taking the key apart is what makes the summary and
 * the request carry the catalogue rows the rules were checked against.
 */
export function proposedPool(
  draft: ProposalDraft,
  catalog: readonly RegisteredInstrument[],
): ProposedPool | null {
  const base = registeredInstrument(catalog, draft.base);
  const quote = registeredInstrument(catalog, draft.quote);
  return base && quote ? { draft, base, quote } : null;
}

/** The request body, trimmed, with nothing the venue assigns for itself. */
export function toProposal({ draft, base, quote }: ProposedPool): CreatePoolProposal {
  return {
    name: draft.name.trim(),
    baseInstrumentId: { admin: base.admin, id: base.id },
    quoteInstrumentId: { admin: quote.admin, id: quote.id },
    baseAccountId: draft.baseAccountId.trim(),
    quoteAccountId: draft.quoteAccountId.trim(),
    lpTokenId: draft.lpTokenId.trim(),
    feeBps: draft.feeBps.trim(),
    baseReserve: draft.baseReserve.trim(),
    quoteReserve: draft.quoteReserve.trim(),
    lpTokenSupply: draft.lpTokenSupply.trim(),
  };
}
