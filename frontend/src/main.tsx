import { createDexClient } from '@canton-dex/client';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
import { App } from './App';
import { DemoRuntime, KeycloakRuntime } from './app/runtime';
import { apiBaseUrl, authMode, keycloakConfig, snapTarget } from './auth/config';
import { createKeycloakAuth } from './auth/keycloak';
import { applyStoredTheme } from './app/useTheme';
import { isDocsHash } from './features/docs/routes';
import { venueClient } from './lib/api/venue';
import { createMetaMaskWallet } from './wallet/metamask';
import { createFixtureBackend } from './mocks/client';

/**
 * Composition point. This is the only module that builds a client, and the only
 * one that knows a fixture exists.
 *
 * In real mode the venue serves the profile, the onboarding and the pool
 * catalogue, and the token is read from the identity provider immediately
 * before every request. In demo mode nothing leaves the browser.
 */
function realSession() {
  // A docs link opens without the silent sign-in check, whose redirect drops the link.
  const auth = createKeycloakAuth(keycloakConfig(), {
    checkSso: !isDocsHash(window.location.hash),
  });
  const client = venueClient(
    createDexClient({ baseUrl: apiBaseUrl(), getAccessToken: () => auth.accessToken() }),
  );
  return (
    <KeycloakRuntime auth={auth} client={client} wallet={createMetaMaskWallet(window, snapTarget())}>
      <App />
    </KeycloakRuntime>
  );
}

function demoSession() {
  return (
    <DemoRuntime backend={createFixtureBackend()}>
      <App />
    </DemoRuntime>
  );
}

// Before the first paint, so a reload does not flash the default theme.
applyStoredTheme();

const session = authMode() === 'keycloak' ? realSession() : demoSession();

createRoot(document.getElementById('root')!).render(<StrictMode>{session}</StrictMode>);
