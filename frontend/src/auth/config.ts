import { resolveSnapTarget } from '../wallet/snap';
import type { SnapTarget } from '../wallet/types';

/**
 * Entry point for environment configuration. Nothing else reads `import.meta.env`.
 *
 * Only public coordinates live here: the OIDC endpoint, the API prefix and the
 * Snap this build installs. No secret, password or admin credential is ever
 * read into the bundle.
 */
export interface KeycloakConfig {
  url: string;
  realm: string;
  clientId: string;
}

export type AuthMode = 'demo' | 'keycloak';

export function authMode(): AuthMode {
  return import.meta.env.VITE_AUTH_MODE === 'keycloak' ? 'keycloak' : 'demo';
}

/**
 * Where the venue API lives. The dev server proxies this prefix to the backend,
 * so the browser stays same-origin and the backend needs no CORS rule.
 */
export function apiBaseUrl(): string {
  return import.meta.env.VITE_API_BASE_URL?.trim() || '/api';
}

export function keycloakConfig(): KeycloakConfig {
  return {
    url: import.meta.env.VITE_KEYCLOAK_URL ?? 'http://localhost:18082',
    realm: import.meta.env.VITE_KEYCLOAK_REALM ?? 'Dex',
    clientId: import.meta.env.VITE_KEYCLOAK_CLIENT_ID ?? 'dex-web',
  };
}

/**
 * Which Canton Snap to install. The published one, unless a development build
 * names a Snap served from this machine.
 */
export function snapTarget(): SnapTarget {
  return resolveSnapTarget(import.meta.env.VITE_SNAP_ID, import.meta.env.DEV);
}
