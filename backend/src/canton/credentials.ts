import type { ServiceIdentity } from '../platform/config.js';
import { integer, optionalString, record } from './decode.js';

const TOKEN_TIMEOUT_MS = 10_000;
/** Refresh this long before expiry. */
const REFRESH_MARGIN_SECONDS = 20;
const DEFAULT_EXPIRY_SECONDS = 60;

/**
 * The cached client-credentials token of one service identity. Concurrent callers share one
 * refresh. Caller tokens never pass through here.
 */
export class ServiceCredentials {
  private cached: { readonly token: string; readonly refreshAt: number } | undefined;
  private refreshing: Promise<string> | undefined;

  constructor(
    private readonly tokenUrl: URL,
    private readonly identity: ServiceIdentity,
  ) {}

  get userId(): string {
    return this.identity.userId;
  }

  async token(): Promise<string> {
    if (this.cached && Date.now() < this.cached.refreshAt) return this.cached.token;
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async refresh(): Promise<string> {
    const response = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.identity.clientId,
        client_secret: this.identity.clientSecret,
      }),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    if (response.status !== 200) throw new Error(`Ledger token request failed: HTTP ${String(response.status)}`);
    const payload = record(await response.json(), 'token response');
    const token = optionalString(payload.access_token, 'access_token');
    if (!token?.trim()) throw new Error('Ledger token response has no access token');
    const expiresIn =
      payload.expires_in === undefined ? DEFAULT_EXPIRY_SECONDS : integer(payload.expires_in, 'expires_in');
    this.cached = { token, refreshAt: Date.now() + Math.max(1, expiresIn - REFRESH_MARGIN_SECONDS) * 1_000 };
    return token;
  }
}
