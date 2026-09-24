import { randomUUID } from 'node:crypto';
import type { CantonAdmin } from '../canton/admin.js';
import { ServiceCredentials } from '../canton/credentials.js';
import type { LedgerHttp } from '../canton/http.js';
import { Ledger } from '../canton/ledger.js';
import type { Role } from '../iam/accounts.js';
import type { ServiceIdentity } from '../platform/config.js';
import type { Db } from '../platform/database.js';
import type { KeycloakFixtures } from './keycloak.js';

export interface Actor {
  readonly name: string;
  readonly party: string;
  readonly ledger: Ledger;
}

/** A fixture actor's party and ledger identity, without its client secret. */
export async function fixtureParty(
  db: Db,
  name: string,
): Promise<{ readonly party: string; readonly userId: string; readonly clientId: string }> {
  return db
    .selectFrom('fixture_parties')
    .select(['party_id as party', 'ledger_user_id as userId', 'ledger_client_id as clientId'])
    .where('name', '=', name)
    .executeTakeFirstOrThrow();
}

/** Development parties, their Ledger API users, and fixture accounts. Outside the runtime API. */
export class DevelopmentFixtures {
  constructor(
    private readonly db: Db,
    private readonly admin: CantonAdmin,
    private readonly keycloak: KeycloakFixtures,
    private readonly http: LedgerHttp,
    private readonly tokenUrl: URL,
  ) {}

  /** A local party `dex-<name>` whose user acts only as that party, with optional read rights. */
  async actor(name: string, identity?: ServiceIdentity, readers: readonly string[] = []): Promise<Actor> {
    const resolved = identity ?? (await this.keycloak.ledgerIdentity(name));
    const party = await this.admin.ensureParty(`dex-${name}`);
    await this.admin.ensureUser(resolved.userId, party, readers);
    await this.db
      .insertInto('fixture_parties')
      .values({ name, party_id: party, ledger_user_id: resolved.userId, ledger_client_id: resolved.clientId })
      .onConflict((conflict) => conflict.column('name').doNothing())
      .execute();
    return { name, party, ledger: Ledger.service(this.http, new ServiceCredentials(this.tokenUrl, resolved)) };
  }

  /** A fixture account whose role the database owns from the start. */
  async account(name: string, issuer: string, subject: string, role: Role): Promise<void> {
    await this.db
      .insertInto('accounts')
      .values({ id: randomUUID(), issuer, subject, display_name: name, role })
      .onConflict((conflict) => conflict.columns(['issuer', 'subject']).doNothing())
      .execute();
  }

  async venueConfiguration(synchronizerId: string, participantId: string): Promise<void> {
    await this.db
      .insertInto('venue_configuration')
      .values({ id: 1, synchronizer_id: synchronizerId, participant_id: participantId })
      .onConflict((conflict) =>
        conflict.column('id').doUpdateSet({ synchronizer_id: synchronizerId, participant_id: participantId }),
      )
      .execute();
  }
}
