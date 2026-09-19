/** Who the identity provider says is signed in. Roles never come from here. */
export interface AuthPrincipal {
  issuer: string;
  subject: string;
  username: string | undefined;
}

export type AuthStatus = 'starting' | 'anonymous' | 'authenticated' | 'failed';

export interface AuthState {
  status: AuthStatus;
  principal: AuthPrincipal | null;
  error: Error | null;
}

/**
 * Everything the webapp needs from an identity provider, and nothing more.
 *
 * The composition point hands `accessToken` to the SDK, which calls it again
 * before every request. No screen calls it, and nothing stores what it returns.
 */
export interface AuthAdapter {
  start(onChange: (state: AuthState) => void): Promise<void>;
  login(): Promise<void>;
  /** Sends the visitor to the provider's own sign-up page. */
  register(): Promise<void>;
  logout(): Promise<void>;
  accessToken(): Promise<string | null>;
}
