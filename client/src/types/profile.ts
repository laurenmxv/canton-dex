/** What the backend's account directory says about the caller. */
export type Role = 'TRADER' | 'OPERATOR';

/**
 * The authenticated caller.
 *
 * The role comes from the backend's database, never from a token claim, and a
 * valid identity the venue has not seen before is provisioned as a trader.
 * `partyId` is null until an onboarding registers one.
 */
export interface Profile {
  accountId: string;
  displayName: string;
  role: Role;
  partyId: string | null;
}
