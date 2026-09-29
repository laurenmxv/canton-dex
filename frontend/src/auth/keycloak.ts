/**
 * Keycloak is the identity provider for login. It issues the tokens that the configured
 * participant accepts.
 *
 * @remarks
 * Bootstrap configures this issuer on the participant. Trader operations and operator access
 * reviews relay login tokens. Daml commands acting as the operator party and the DVO CLI use
 * service credentials.
 *
 * @packageDocumentation
 */
import Keycloak from 'keycloak-js';
import type { KeycloakConfig } from './config';
import type { AuthAdapter, AuthState } from './types';

/**
 * Authorization Code with PKCE S256 against the local Keycloak realm.
 *
 * Tokens stay in memory inside the keycloak-js instance. Nothing is written to
 * storage, and a failed start never degrades into the demo adapter.
 */
export function createKeycloakAuth(config: KeycloakConfig): AuthAdapter {
  const keycloak = new Keycloak({
    url: config.url,
    realm: config.realm,
    clientId: config.clientId,
  });
  const origin = window.location.origin + window.location.pathname;
  let subscriber: (state: AuthState) => void = () => {};
  // keycloak-js refuses a second init, and StrictMode mounts effects twice.
  let started: Promise<void> | null = null;
  // The last state published, null until there is one. Every sign-in and
  // sign-out keycloak-js makes arrives through onAuthSuccess or onAuthLogout,
  // so this is never an identity the provider has since dropped.
  let current: AuthState | null = null;

  function publish(state: AuthState) {
    current = state;
    subscriber(state);
  }

  function snapshot(): AuthState {
    if (!keycloak.authenticated || !keycloak.tokenParsed) {
      return { status: 'anonymous', principal: null, error: null };
    }
    const claims = keycloak.tokenParsed as { iss?: string; sub?: string; preferred_username?: string };
    // The subject is what tells one caller from another. A token without one
    // cannot be trusted to keep two sessions apart, so it is refused.
    if (!claims.sub) {
      return {
        status: 'failed',
        principal: null,
        error: new Error('The identity provider issued a token with no subject'),
      };
    }
    return {
      status: 'authenticated',
      principal: {
        issuer: claims.iss ?? `${config.url}/realms/${config.realm}`,
        subject: claims.sub,
        username: claims.preferred_username,
      },
      error: null,
    };
  }

  return {

    async start(onChange) {
      subscriber = onChange;
      // A runtime mounted again after the answer, as HMR does, is told it
      // rather than left starting.
      if (current) onChange(current);
      if (started) return started;
      keycloak.onAuthSuccess = () => publish(snapshot());
      keycloak.onAuthLogout = () => publish(snapshot());
      keycloak.onTokenExpired = () => {
        void keycloak.updateToken(30).catch(() => keycloak.clearToken());
      };
      started = (async () => {
        try {
          await keycloak.init({
            onLoad: 'check-sso',
            pkceMethod: 'S256',
            // No hidden iframe, so the adapter works without a silent-check page.
            checkLoginIframe: false,
            redirectUri: origin,
          });
          publish(snapshot());
        } catch (cause) {
          publish({
            status: 'failed',
            principal: null,
            error: new Error(
              `Could not reach the identity provider at ${config.url}. ${
                cause instanceof Error ? cause.message : String(cause)
              }`,
            ),
          });
        }
      })();
      return started;
    },

    async login() {
      await keycloak.login({ redirectUri: origin });
    },

    /**
     * The realm's own registration page. The webapp never collects a password
     * and never creates an account of its own.
     */
    async register() {
      await keycloak.register({ redirectUri: origin });
    },

    async logout() {
      await keycloak.logout({ redirectUri: origin });
    },

    async accessToken() {
      if (!keycloak.authenticated) return null;
      try {
        await keycloak.updateToken(30);
      } catch {
        return null;
      }
      return keycloak.token ?? null;
    },
  };
}
