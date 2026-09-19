/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `keycloak` turns on real sign-in. Anything else keeps the offline demo. */
  readonly VITE_AUTH_MODE?: string;
  readonly VITE_KEYCLOAK_URL?: string;
  readonly VITE_KEYCLOAK_REALM?: string;
  readonly VITE_KEYCLOAK_CLIENT_ID?: string;
  /**
   * The Canton Snap to install. Unset means the published one. A development
   * build may name a loopback Snap, such as `local:http://localhost:4040`.
   */
  readonly VITE_SNAP_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
