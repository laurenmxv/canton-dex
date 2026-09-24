import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CantonAdmin } from '../../../src/canton/admin.js';
import { ServiceCredentials } from '../../../src/canton/credentials.js';
import { LedgerHttp } from '../../../src/canton/http.js';
import { Ledger } from '../../../src/canton/ledger.js';
import { at } from '../../support/json.js';
import { fakeParticipant, TOKEN_ROUTE, type FakeParticipant } from '../support/participant.js';

const HINT = 'dex-operator';
const LOCAL = `${HINT}::current-participant`;
const REMOTE = { party: `${HINT}::previous-participant`, isLocal: false };

describe('Canton admin parties', () => {
  let participant: FakeParticipant;
  let admin: CantonAdmin;
  const pages = new Map<string, { partyDetails: unknown[]; nextPageToken?: string }>();

  beforeEach(async () => {
    pages.clear();
    participant = await fakeParticipant({
      ...TOKEN_ROUTE,
      'GET /v2/parties': (exchange) => ({ body: pages.get(exchange.query.get('pageToken') ?? '') }),
      'POST /v2/parties': () => {
        const allocated = { party: LOCAL, isLocal: true };
        pages.set('', { partyDetails: [REMOTE, allocated] });
        return { body: { partyDetails: allocated } };
      },
    });
    const credentials = new ServiceCredentials(new URL('/token', participant.url), {
      userId: 'admin',
      clientId: 'admin',
      clientSecret: 'test-secret',
    });
    admin = new CantonAdmin(Ledger.service(new LedgerHttp(participant.url), credentials));
  });
  afterEach(() => participant.close());

  const listings = () =>
    participant.exchanges.filter((exchange) => exchange.method === 'GET' && exchange.path === '/v2/parties');
  const allocations = () =>
    participant.exchanges.filter((exchange) => exchange.method === 'POST' && exchange.path === '/v2/parties');

  it('reuses the local party even when a remote party appears first', async () => {
    pages.set('', { partyDetails: [REMOTE, { party: LOCAL, isLocal: true }] });
    expect(await admin.ensureParty(HINT)).toBe(LOCAL);
    expect(allocations()).toEqual([]);
    expect(listings().map((exchange) => exchange.query.get('filter-party'))).toEqual([`${HINT}::`]);
  });

  it('looks for the local party across pages before allocating', async () => {
    pages.set('', { partyDetails: [REMOTE], nextPageToken: 'next' });
    pages.set('next', { partyDetails: [{ party: LOCAL, isLocal: true }] });
    expect(await admin.ensureParty(HINT)).toBe(LOCAL);
    expect(listings().map((exchange) => exchange.query.get('pageToken') ?? '')).toEqual(['', 'next']);
    expect(allocations()).toEqual([]);
  });

  it('allocates a local party when only remote or different hints exist, and reuses it on retry', async () => {
    pages.set('', { partyDetails: [REMOTE, { party: `other-${LOCAL}`, isLocal: true }] });
    expect(await admin.ensureParty(HINT)).toBe(LOCAL);
    expect(await admin.ensureParty(HINT)).toBe(LOCAL);
    expect(allocations().map((exchange) => at(exchange.body, 'partyIdHint'))).toEqual([HINT]);
  });
});
