import { describe, expect, it } from 'vitest';
import {
  draftErrors,
  emptyDraft,
  suggestedIds,
  toProposal,
  type ProposalDraft,
} from '../features/pools/poolForm';

const OPTIONS = {
  factoryId: '00factory',
  dvo: 'dvo::1220',
  venueOperator: 'operator::1220',
  instrumentAdmins: [{ partyId: 'issuer::1220', label: 'Issuer' }],
};

function draft(overrides: Partial<ProposalDraft> = {}): ProposalDraft {
  return {
    ...emptyDraft(OPTIONS),
    baseId: 'USDC',
    quoteAdmin: 'issuer-eurc::1220',
    quoteId: 'EURC',
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
  it('accepts a complete draft', () => {
    expect(draftErrors(draft())).toEqual({});
  });

  it('starts on the first admin the venue configured, and nothing invented', () => {
    const fresh = emptyDraft(OPTIONS);
    expect(fresh.baseAdmin).toBe('issuer::1220');
    expect(emptyDraft().baseAdmin).toBe('');
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
    expect(draftErrors(draft({ baseReserve: value })).baseReserve).toBeDefined();
  });

  it('accepts the largest amount a Decimal holds', () => {
    const large = `${'9'.repeat(28)}.${'9'.repeat(10)}`;
    expect(draftErrors(draft({ baseReserve: large })).baseReserve).toBeUndefined();
  });

  it('refuses a left-padded amount, which the venue reads as malformed', () => {
    expect(draftErrors(draft({ baseReserve: '01' })).baseReserve).toBeDefined();
    expect(draftErrors(draft({ baseReserve: '00.5' })).baseReserve).toBeDefined();
    expect(draftErrors(draft({ feeBps: '030' })).feeBps).toBeDefined();
    // A single leading zero before the point is the number zero, not padding.
    expect(draftErrors(draft({ feeBps: '0.5' })).feeBps).toBeUndefined();
  });

  it('takes identifiers as long as the venue does, and no longer', () => {
    const id = (length: number) => 'a'.repeat(length);

    expect(draftErrors(draft({ baseId: id(65) })).baseId).toBeUndefined();
    expect(draftErrors(draft({ baseId: id(128) })).baseId).toBeUndefined();
    expect(draftErrors(draft({ baseId: id(129) })).baseId).toBeDefined();
    expect(draftErrors(draft({ lpTokenId: id(128) })).lpTokenId).toBeUndefined();
    expect(draftErrors(draft({ baseAccountId: id(129) })).baseAccountId).toBeDefined();
    expect(draftErrors(draft({ quoteAdmin: `${id(255)}` })).quoteAdmin).toBeUndefined();
    expect(draftErrors(draft({ quoteAdmin: `${id(256)}` })).quoteAdmin).toBeDefined();
  });

  it('refuses a control character in any text the venue stores', () => {
    expect(draftErrors(draft({ name: 'USDC \u0007 EURC' })).name).toBeDefined();
    expect(draftErrors(draft({ baseId: 'US\u0000DC' })).baseId).toBeDefined();
    expect(draftErrors(draft({ lpTokenId: 'LP\nX' })).lpTokenId).toBeDefined();
    // The C1 range the venue also refuses, which is not printable either.
    expect(draftErrors(draft({ lpTokenId: 'LP\u0085X' })).lpTokenId).toBeDefined();
    expect(draftErrors(draft({ baseAccountId: 'base\u009fid' })).baseAccountId).toBeDefined();
    expect(draftErrors(draft({ name: 'USDC \u00a0 EURC' })).name).toBeUndefined();
  });

  it.each([
    ['10000', 'a whole fee'],
    ['10000.0000000001', 'more than a whole fee'],
    ['99999', 'far more'],
    ['', 'nothing'],
    ['-5', 'a negative fee'],
  ])('refuses %s as a fee, which is %s', (value) => {
    expect(draftErrors(draft({ feeBps: value })).feeBps).toBeDefined();
  });

  it.each(['0', '0.5', '30', '9999.9999999999'])('accepts %s bps', (value) => {
    expect(draftErrors(draft({ feeBps: value })).feeBps).toBeUndefined();
  });

  it('refuses a pair of the same instrument, and allows the same id from two admins', () => {
    const same = draft({ quoteAdmin: 'issuer::1220', quoteId: 'USDC' });
    expect(draftErrors(same).quoteId).toBeDefined();

    const twoAdmins = draft({ quoteAdmin: 'other-issuer::1220', quoteId: 'USDC' });
    expect(draftErrors(twoAdmins).quoteId).toBeUndefined();
  });

  it('names every field the venue requires', () => {
    const errors = draftErrors(emptyDraft());
    expect(Object.keys(errors).sort()).toEqual([
      'baseAccountId',
      'baseAdmin',
      'baseId',
      'baseReserve',
      'lpTokenId',
      'lpTokenSupply',
      'name',
      'quoteAccountId',
      'quoteAdmin',
      'quoteId',
      'quoteReserve',
    ]);
  });
});

describe('what the pair suggests', () => {
  it('fills the name and the identifiers from the instruments', () => {
    expect(suggestedIds(draft({ name: '', baseAccountId: '', lpTokenId: '' }))).toEqual({
      name: 'USDC / EURC',
      baseAccountId: 'usdc-eurc-base',
      quoteAccountId: 'usdc-eurc-quote',
      lpTokenId: 'LP-USDC-EURC',
    });
  });

  it('suggests nothing until both instruments are there', () => {
    expect(suggestedIds(draft({ quoteId: '' }))).toEqual({
      name: '',
      baseAccountId: '',
      quoteAccountId: '',
      lpTokenId: '',
    });
  });
});

describe('what goes on the wire', () => {
  it('trims every value, and keeps each amount a string', () => {
    const body = toProposal(draft({ baseId: '  USDC  ', baseReserve: ' 1000000 ' }));

    expect(body.baseInstrumentId).toEqual({ admin: 'issuer::1220', id: 'USDC' });
    expect(body.baseReserve).toBe('1000000');
    for (const amount of [body.feeBps, body.baseReserve, body.quoteReserve, body.lpTokenSupply]) {
      expect(typeof amount).toBe('string');
    }
  });

  it('carries nothing the venue assigns for itself', () => {
    expect(Object.keys(toProposal(draft())).sort()).toEqual([
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
