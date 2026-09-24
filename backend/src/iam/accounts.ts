import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from '../platform/database.js';
import { AccessDenied } from '../platform/errors.js';

export type Role = 'TRADER' | 'OPERATOR';

export interface Account {
  readonly id: string;
  readonly issuer: string;
  readonly subject: string;
  readonly displayName: string;
  readonly role: Role;
}

/** The role check that workflows repeat after the route's own authorization. */
export function requireRole(account: Account, role: Role): void {
  if (account.role !== role) throw new AccessDenied(`${role} role required`);
}

/** GET /v1/me. */
export interface Profile {
  readonly accountId: string;
  readonly displayName: string;
  readonly role: Role;
  readonly partyId: string | null;
}

/** A connection or an open transaction. */
type Executor = Kysely<Database>;

const ACCOUNT_COLUMNS = ['id', 'issuer', 'subject', 'display_name as displayName', 'role'] as const;

/**
 * Provisions the account of a validated token. The database owns roles: a first login is a
 * TRADER, and token claims never change a role. Concurrent first requests create one account.
 */
export async function authenticate(
  db: Executor,
  issuer: string,
  subject: string,
  name: string | undefined,
): Promise<Account> {
  await db
    .insertInto('accounts')
    .values({
      id: randomUUID(),
      issuer,
      subject,
      display_name: name?.trim() ? name : subject,
      role: 'TRADER',
    })
    .onConflict((conflict) => conflict.columns(['issuer', 'subject']).doNothing())
    .execute();
  return db
    .selectFrom('accounts')
    .select(ACCOUNT_COLUMNS)
    .where('issuer', '=', issuer)
    .where('subject', '=', subject)
    .executeTakeFirstOrThrow();
}

export async function getAccount(db: Executor, id: string): Promise<Account> {
  return db.selectFrom('accounts').select(ACCOUNT_COLUMNS).where('id', '=', id).executeTakeFirstOrThrow();
}

export async function profile(db: Executor, caller: Account): Promise<Profile> {
  const { partyId } = await db
    .selectFrom('accounts')
    .select('party_id as partyId')
    .where('id', '=', caller.id)
    .executeTakeFirstOrThrow();
  return { accountId: caller.id, displayName: caller.displayName, role: caller.role, partyId };
}

/** Binds the confirmed party once; an account never changes to another party. */
export async function bindParty(db: Executor, accountId: string, party: string): Promise<void> {
  const result = await db
    .updateTable('accounts')
    .set({ party_id: party })
    .where('id', '=', accountId)
    .where((row) => row.or([row('party_id', 'is', null), row('party_id', '=', party)]))
    .executeTakeFirst();
  if (result.numUpdatedRows !== 1n) throw new Error('Account already has another party');
}
