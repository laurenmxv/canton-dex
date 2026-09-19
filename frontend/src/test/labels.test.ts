import { describe, expect, it } from 'vitest';
import { accessStep, accessStepPoolId, ATTESTATION_STEP } from '../lib/api/ledger-steps';
import type { Instrument, Pool, SwapDirection, SwapRequest } from '../lib/api/types';
import { parseAmount, toDecimal } from '../lib/api/types';
import {
  formatAmount,
  formatCountdown,
  inputSymbolOf,
  ledgerStepLabel,
  shortParty,
} from '../lib/labels';

describe('ledger step keys', () => {
  it('round-trips a pool access key', () => {
    expect(accessStepPoolId(accessStep('pool-usdc-eurc'))).toBe('pool-usdc-eurc');
  });

  it('reads the attestation step as no pool at all', () => {
    expect(accessStepPoolId(ATTESTATION_STEP)).toBeNull();
    expect(ledgerStepLabel(ATTESTATION_STEP, () => 'unused')).toBe('KYC attestation');
  });

  it('names the pool an access step grants', () => {
    expect(ledgerStepLabel(accessStep('pool-1'), () => 'USDC / EURC')).toBe(
      'Pool access, USDC / EURC',
    );
  });
});

describe('countdown', () => {
  const at = (iso: string) => Date.parse(iso);

  it('reads as expired once the moment passes', () => {
    expect(formatCountdown('2026-01-01T00:00:00Z', at('2026-01-01T00:00:00Z'))).toBe('expired');
    expect(formatCountdown('2026-01-01T00:00:00Z', at('2026-01-01T00:05:00Z'))).toBe('expired');
  });

  it('rolls over from seconds into minutes', () => {
    expect(formatCountdown('2026-01-01T00:00:59Z', at('2026-01-01T00:00:00Z'))).toBe('59s');
    expect(formatCountdown('2026-01-01T00:02:05Z', at('2026-01-01T00:00:00Z'))).toBe('2m 5s');
  });
});

describe('amounts', () => {
  it('returns a value it cannot parse untouched, rather than NaN', () => {
    expect(formatAmount('not-a-number')).toBe('not-a-number');
  });

  it('groups and keeps a sensible number of decimals', () => {
    expect(formatAmount('4200000.0000000000')).toBe('4,200,000.00');
    expect(formatAmount('22919.6080412345')).toBe('22,919.608041');
  });

  it('refuses an amount the ledger cannot hold', () => {
    expect(() => toDecimal(Number.POSITIVE_INFINITY)).toThrow('out of range');
    expect(toDecimal(1.5)).toBe('1.5000000000');
  });

  it('treats a blank field as missing, not as zero', () => {
    expect(parseAmount('')).toBeUndefined();
    expect(parseAmount('   ')).toBeUndefined();
    expect(parseAmount('abc')).toBeUndefined();
    expect(parseAmount('0')).toBe(0);
  });
});

describe('identifiers', () => {
  it('keeps the readable hint at the front of a party', () => {
    const party = 'alice-carter::1220f4c1a977a';
    expect(shortParty(party)).toBe(party);
    expect(shortParty(`${party}${'0'.repeat(40)}`)).toMatch(/^alice-carter::1220…0{8}$/);
  });
});

describe('the instrument a swap request pays in', () => {
  const pool: Pool = {
    poolId: 'pool-1',
    name: 'USDC / EURC',
    baseInstrumentId: 'inst-usdc',
    quoteInstrumentId: 'inst-eurc',
    feeBps: 30,
    baseReserve: '1000.0',
    quoteReserve: '1000.0',
    lpTokenSupply: '1000.0',
    createdAt: '2026-09-17T08:00:00Z',
  };
  const instruments: Instrument[] = [
    { id: 'inst-usdc', symbol: 'USDC', admin: 'venue::1220' },
    { id: 'inst-eurc', symbol: 'EURC', admin: 'venue::1220' },
  ];

  function requestOn(direction: SwapDirection): SwapRequest {
    return {
      requestId: 'req-1',
      poolId: 'pool-1',
      poolName: 'USDC / EURC',
      trader: 'acc-trader-alice',
      direction,
      amountIn: '25000.0',
      minOut: '24000.0',
      expectedOut: '24900.0',
      status: 'AWAITING_SETTLEMENT',
      submittedAt: '2026-09-17T09:00:00Z',
      settlementDeadline: '2026-09-17T10:00:00Z',
    };
  }

  it('reads the base side paying in, and the quote side paying out', () => {
    expect(inputSymbolOf(requestOn('BaseToQuote'), [pool], instruments)).toBe('USDC');
    expect(inputSymbolOf(requestOn('QuoteToBase'), [pool], instruments)).toBe('EURC');
  });

  it('says nothing when the pool is not among the ones it was given', () => {
    expect(inputSymbolOf(requestOn('BaseToQuote'), [], instruments)).toBe('');
  });

  it('falls back to the raw identifier when the catalogue is missing', () => {
    expect(inputSymbolOf(requestOn('BaseToQuote'), [pool], [])).toBe('inst-usdc');
  });
});
