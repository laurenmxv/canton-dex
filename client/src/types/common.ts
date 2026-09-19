/** Pass-through options every operation accepts. */
export interface RequestOptions {
  /** Cancels the request. An aborted signal stops it before it is sent. */
  signal?: AbortSignal;
}

/** Everything a client needs to reach one deployment of the DEX API. */
export interface DexClientConfig {
  /**
   * Where the API lives: an absolute `http(s)` origin, optionally with a path
   * prefix, or a root-relative path for a same-origin deployment. A trailing
   * slash is ignored.
   */
  baseUrl: string;
  /** Consulted immediately before every request. The caller owns refresh. */
  getAccessToken: () => string | null | Promise<string | null>;
  fetchImpl?: typeof fetch;
}
