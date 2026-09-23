import { describe, expect, it } from 'vitest';
import type { RegisteredInstrument } from '../lib/api/types';
import {
  draftErrors,
  emptyDraft,
  instrumentChoices,
  instrumentKey,
  proposedPool,
  suggestedName,
  toProposal,
  type ProposalDraft,
} from '../features/pools/poolForm';

const USDC: RegisteredInstrument = {
  admin: 'issuer::1220',
  id: 'USDC',
  symbol: 'USDC',
  decimals: 6,
};
const EURC: RegisteredInstrument = {
  admin: 'issuer-eurc::1220',
  id: 'EURC',
  symbol: 'EURC',
  decimals: 6,
};
/** The same symbol and the same id, from another administrator. */
const OTHER_USDC: RegisteredInstrument = {
  admin: 'other-issuer::1220',
  id: 'USDC',
  symbol: 'USDC',
  decimals: 6,
};
const CATALOG: RegisteredInstrument[] = [USDC, EURC, OTHER_USDC];

function draft(overrides: Partial<ProposalDraft> = {}): ProposalDraft {
  return {
    ...emptyDraft(),
    base: instrumentKey(USDC),
    quote: instrumentKey(EURC),
    name: 'USDC / EURC',
    ...overrides,
  };
}

describe('what a proposal may carry', () => {
  it('accepts a complete draft, and only while the venue still registers its pair', () => {
    expect(draftErrors(draft(), CATALOG)).toEqual({});

    const gone = draft({ base: instrumentKey({ admin: 'retired::1220', id: 'USDC' }) });
    expect(draftErrors(gone, CATALOG).base).toBe('Base instrument is no longer registered');
    expect(draftErrors(draft(), []).quote).toBe('Quote instrument is no longer registered');
  });

  it('starts on nothing chosen, and nothing invented', () => {
    expect(emptyDraft()).toEqual({ name: '', base: '', quote: '', feeBps: '30' });
  });

  it('takes a name as long as the venue does, and no longer', () => {
    expect(draftErrors(draft({ name: 'a'.repeat(120) }), CATALOG).name).toBeUndefined();
    expect(draftErrors(draft({ name: 'a'.repeat(121) }), CATALOG).name).toBeDefined();
  });

  it('refuses a control character in the name the venue stores', () => {
    expect(draftErrors(draft({ name: 'USDC \u0007 EURC' }), CATALOG).name).toBeDefined();
    // The C1 range the venue also refuses, which is not printable either.
    expect(draftErrors(draft({ name: 'USDC\u0085EURC' }), CATALOG).name).toBeDefined();
    expect(draftErrors(draft({ name: 'USDC \u00a0 EURC' }), CATALOG).name).toBeUndefined();
  });

  it.each([
    ['10000', 'a whole fee'],
    ['99999', 'far more'],
    ['0.5', 'a fraction'],
    ['30.0', 'written with a fraction'],
    ['030', 'left-padded'],
    ['', 'nothing'],
    ['-5', 'a negative fee'],
  ])('refuses %s as a fee, which is %s', (value) => {
    expect(draftErrors(draft({ feeBps: value }), CATALOG).feeBps).toBeDefined();
  });

  it.each(['0', '30', '9999'])('accepts %s bps', (value) => {
    expect(draftErrors(draft({ feeBps: value }), CATALOG).feeBps).toBeUndefined();
  });

  it('tells two instruments apart by their whole identity, in a pair and on offer', () => {
    const same = draft({ quote: instrumentKey(USDC) });
    expect(draftErrors(same, CATALOG).quote).toBeDefined();

    const twoAdmins = draft({ quote: instrumentKey(OTHER_USDC) });
    expect(draftErrors(twoAdmins, CATALOG).quote).toBeUndefined();

    // Only a row another row reads the same as carries its administrator.
    expect(instrumentChoices(CATALOG)).toEqual([
      { value: instrumentKey(USDC), label: `USDC (${USDC.admin})` },
      { value: instrumentKey(EURC), label: 'EURC' },
      { value: instrumentKey(OTHER_USDC), label: `USDC (${OTHER_USDC.admin})` },
    ]);
    const wrapped = { admin: USDC.admin, id: '0x01', symbol: 'WBTC', decimals: 8 };
    expect(instrumentChoices([wrapped])[0]?.label).toBe('WBTC · 0x01');
  });

  it('names every field the venue requires', () => {
    const errors = draftErrors(emptyDraft(), CATALOG);
    expect(Object.keys(errors).sort()).toEqual(['base', 'name', 'quote']);
  });
});

describe('what the pair suggests', () => {
  it('names the pool after the instruments’ own identifiers', () => {
    expect(suggestedName(draft({ name: '' }), CATALOG)).toBe('USDC / EURC');
  });

  it('suggests nothing until both instruments are there', () => {
    expect(suggestedName(draft({ quote: '' }), CATALOG)).toBe('');
  });
});

/** The draft with its pair resolved, which is the only thing a proposal is built from. */
function proposed(from: ProposalDraft) {
  const resolved = proposedPool(from, CATALOG);
  if (!resolved) throw new Error('The test catalogue does not register this pair');
  return resolved;
}

describe('what goes on the wire', () => {
  it('carries each instrument whole, and keeps the fee a trimmed string', () => {
    const body = toProposal(proposed(draft({ feeBps: ' 30 ' })));

    expect(body.baseInstrumentId).toEqual({ admin: 'issuer::1220', id: 'USDC' });
    expect(body.quoteInstrumentId).toEqual({ admin: 'issuer-eurc::1220', id: 'EURC' });
    expect(body.feeBps).toBe('30');
  });

  it('carries nothing the venue or the dvo assigns', () => {
    expect(Object.keys(toProposal(proposed(draft()))).sort()).toEqual([
      'baseInstrumentId',
      'feeBps',
      'name',
      'quoteInstrumentId',
    ]);
  });
});
