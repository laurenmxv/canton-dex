import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';

/** One request that the fake participant received. */
export interface Exchange {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

export interface Answer {
  readonly status?: number;
  readonly body?: unknown;
}

/** Answers a request; routes are keyed by `METHOD /path` without the query. */
export type Route = (exchange: Exchange) => Answer | Promise<Answer>;

export interface FakeParticipant {
  readonly url: URL;
  readonly exchanges: Exchange[];
  close(): Promise<void>;
}

/** A Canton error body, as the JSON Ledger API writes it. */
export function cantonError(status: number, grpcCodeValue: number, cause: string, code = 'NA'): Answer {
  return {
    status,
    body: {
      code,
      cause,
      correlationId: null,
      traceId: null,
      context: {},
      resources: [],
      errorCategory: -1,
      grpcCodeValue,
    },
  };
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  const text = Buffer.concat(chunks).toString('utf8');
  const parsed: unknown = text === '' ? undefined : JSON.parse(text);
  return parsed;
}

/** A local HTTP server in place of the JSON Ledger API and the token endpoint. */
export async function fakeParticipant(routes: Readonly<Record<string, Route>>): Promise<FakeParticipant> {
  const exchanges: Exchange[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const target = new URL(request.url ?? '/', 'http://participant');
      const exchange: Exchange = {
        method: request.method ?? 'GET',
        path: target.pathname,
        query: target.searchParams,
        authorization: request.headers.authorization,
        body: request.headers['content-type']?.includes('json') ? await body(request) : undefined,
      };
      exchanges.push(exchange);
      const route = routes[`${exchange.method} ${exchange.path}`];
      const answer = route
        ? await route(exchange)
        : cantonError(404, 5, `No route ${exchange.method} ${exchange.path}`);
      response.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
      response.end(answer.body === undefined ? '' : JSON.stringify(answer.body));
    })().catch((error: unknown) => {
      response.writeHead(599, { 'content-type': 'text/plain' });
      response.end(String(error));
    });
  });
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('The fake participant has no port');
  return {
    url: new URL(`http://127.0.0.1:${String(address.port)}`),
    exchanges,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

/** The token endpoint of a service identity. */
export const TOKEN_ROUTE: Record<string, Route> = {
  'POST /token': () => ({ body: { access_token: 'service-token', expires_in: 3600 } }),
};
