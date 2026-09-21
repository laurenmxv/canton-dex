import { describe, expect, it } from 'vitest';
import type { RegisteredInstrument } from '../lib/api/types';
import {
  draftErrors,
  emptyDraft,
  instrumentChoices,
  instrumentKey,
  proposedPool,
  suggestedIds,
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
    baseReserve: '1000000',
    quoteReserve: '920000',
    lpTokenSupply: '959166.305',
    name: 'USDC / EURC',
    baseAccountId: 'usdc-eurc-base',
    quoteAccountId: 'usdc-eurc-quote',
    lpTokenId: 'LP-USDC-EURC',
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
    const fresh = emptyDraft();
    expect(fresh.base).toBe('');
    expect(fresh.quote).toBe('');
    expect(fresh.baseReserve).toBe('');
    expect(fresh.lpTokenSupply).toBe('');
  });

  it.each([
    ['blank', ''],
    ['a word', 'lots'],
    ['a negative amount', '-1'],
    ['zero', '0'],
    ['zero with decimals', '0.0000000000'],
    ['eleven fractional digits', '1.00000000001'],
    ['twenty-nine integer digits', '1'.repeat(29)],
    ['an exponent', '1e6'],
    ['a thousands separator', '1,000'],
  ])('refuses %s as a reserve', (_name, value) => {
    expect(draftErrors(draft({ baseReserve: value }), CATALOG).baseReserve).toBeDefined();
  });

  it('accepts the largest amount a Decimal holds', () => {
    const large = `${'9'.repeat(28)}.${'9'.repeat(10)}`;
    expect(draftErrors(draft({ baseReserve: large }), CATALOG).baseReserve).toBeUndefined();
  });

  it('refuses a left-padded amount, which the venue reads as malformed', () => {
    expect(draftErrors(draft({ baseReserve: '01' }), CATALOG).baseReserve).toBeDefined();
    expect(draftErrors(draft({ baseReserve: '00.5' }), CATALOG).baseReserve).toBeDefined();
    expect(draftErrors(draft({ feeBps: '030' }), CATALOG).feeBps).toBeDefined();
    // A single leading zero before the point is the number zero, not padding.
    expect(draftErrors(draft({ feeBps: '0.5' }), CATALOG).feeBps).toBeUndefined();
  });

  it('takes identifiers as long as the venue does, and no longer', () => {
    const id = (length: number) => 'a'.repeat(length);

    expect(draftErrors(draft({ lpTokenId: id(128) }), CATALOG).lpTokenId).toBeUndefined();
    expect(draftErrors(draft({ lpTokenId: id(129) }), CATALOG).lpTokenId).toBeDefined();
    expect(draftErrors(draft({ baseAccountId: id(129) }), CATALOG).baseAccountId).toBeDefined();
    expect(draftErrors(draft({ name: id(120) }), CATALOG).name).toBeUndefined();
    expect(draftErrors(draft({ name: id(121) }), CATALOG).name).toBeDefined();
  });

  it('refuses a control character in any text the venue stores', () => {
    expect(draftErrors(draft({ name: 'USDC \u0007 EURC' }), CATALOG).name).toBeDefined();
    expect(draftErrors(draft({ lpTokenId: 'LP\nX' }), CATALOG).lpTokenId).toBeDefined();
    // The C1 range the venue also refuses, which is not printable either.
    expect(draftErrors(draft({ lpTokenId: 'LP\u0085X' }), CATALOG).lpTokenId).toBeDefined();
    expect(draftErrors(draft({ baseAccountId: 'base\u009fid' }), CATALOG).baseAccountId).toBeDefined();
    expect(draftErrors(draft({ name: 'USDC \u00a0 EURC' }), CATALOG).name).toBeUndefined();
  });

  it.each([
    ['10000', 'a whole fee'],
    ['10000.0000000001', 'more than a whole fee'],
    ['99999', 'far more'],
    ['', 'nothing'],
    ['-5', 'a negative fee'],
  ])('refuses %s as a fee, which is %s', (value) => {
    expect(draftErrors(draft({ feeBps: value }), CATALOG).feeBps).toBeDefined();
  });

  it.each(['0', '0.5', '30', '9999.9999999999'])('accepts %s bps', (value) => {
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
    expect(Object.keys(errors).sort()).toEqual([
      'base',
      'baseAccountId',
      'baseReserve',
      'lpTokenId',
      'lpTokenSupply',
      'name',
      'quote',
      'quoteAccountId',
      'quoteReserve',
    ]);
  });
});

describe('what the pair suggests', () => {
  it('fills the name and the identifiers from the instruments', () => {
    expect(suggestedIds(draft({ name: '', baseAccountId: '', lpTokenId: '' }), CATALOG)).toEqual({
      name: 'USDC / EURC',
      baseAccountId: 'usdc-eurc-base',
      quoteAccountId: 'usdc-eurc-quote',
      lpTokenId: 'LP-USDC-EURC',
    });
  });

  it('suggests nothing until both instruments are there', () => {
    expect(suggestedIds(draft({ quote: '' }), CATALOG)).toEqual({
      name: '',
      baseAccountId: '',
      quoteAccountId: '',
      lpTokenId: '',
    });
  });
});

/** The draft with its pair resolved, which is the only thing a proposal is built from. */
function proposed(from: ProposalDraft) {
  const resolved = proposedPool(from, CATALOG);
  if (!resolved) throw new Error('The test catalogue does not register this pair');
  return resolved;
}

describe('what goes on the wire', () => {
  it('carries each instrument whole, and keeps each amount a string', () => {
    const body = toProposal(proposed(draft({ baseReserve: ' 1000000 ' })));

    expect(body.baseInstrumentId).toEqual({ admin: 'issuer::1220', id: 'USDC' });
    expect(body.quoteInstrumentId).toEqual({ admin: 'issuer-eurc::1220', id: 'EURC' });
    expect(body.baseReserve).toBe('1000000');
    for (const amount of [body.feeBps, body.baseReserve, body.quoteReserve, body.lpTokenSupply]) {
      expect(typeof amount).toBe('string');
    }
  });

  it('carries nothing the venue assigns for itself', () => {
    expect(Object.keys(toProposal(proposed(draft()))).sort()).toEqual([
      'baseAccountId',
      'baseInstrumentId',
      'baseReserve',
      'feeBps',
      'lpTokenId',
      'lpTokenSupply',
      'name',
      'quoteAccountId',
      'quoteInstrumentId',
      'quoteReserve',
    ]);
  });
});
