import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Plugin, ResolvedConfig } from 'vite';
import { resolveSnapTarget } from '../src/wallet/snap';
import type { SnapTarget } from '../src/wallet/types';

/**
 * Serving the development Canton Snap while the dev server runs.
 *
 * A Snap's id is an identity: MetaMask derives its keys from it, so the id has
 * to stay exactly `local:http://localhost:4040`, which is why the port is fixed
 * and never moves. Only the four files MetaMask fetches are served, from
 * loopback, and only where the build asked for the local Snap.
 */
export const SNAP_HOST = '127.0.0.1';
export const SNAP_DIRECTORY = 'dev/canton-snap';
/** How long the holder of the port has to answer before it counts as another one. */
const REPLY_TIMEOUT_MS = 2_000;

/**
 * The port the Snap id names.
 *
 * The id is the address MetaMask fetches from, so it decides where to listen.
 * Reading it from the id rather than from a constant is what keeps the two
 * from ever disagreeing.
 */
export function snapPort(target: SnapTarget): number {
  const address = new URL(target.snapId.replace(/^local:/, ''));
  return address.port === '' ? 80 : Number(address.port);
}

interface SnapAsset {
  /** Path of the file, relative to the project root. */
  readonly file: string;
  readonly type: string;
}

/**
 * Every path this serves, and nothing else.
 *
 * MetaMask reads the manifest, then the two files it names, and the package
 * that carries them. A request for anything else, `..` included, finds no
 * entry here, so there is no listing and no way out of this map.
 */
export const SNAP_ASSETS: ReadonlyMap<string, SnapAsset> = new Map([
  ['/snap.manifest.json', { file: `${SNAP_DIRECTORY}/snap.manifest.json`, type: 'application/json' }],
  ['/package.json', { file: `${SNAP_DIRECTORY}/package.json`, type: 'application/json' }],
  ['/dist/bundle.js', { file: `${SNAP_DIRECTORY}/dist/bundle.js`, type: 'text/javascript' }],
  ['/images/icon.svg', { file: `${SNAP_DIRECTORY}/images/icon.svg`, type: 'image/svg+xml' }],
]);

/** The asset a request asks for, or nothing. */
export function snapAsset(url: string | undefined): SnapAsset | null {
  if (url === undefined) return null;
  const path = url.split('?')[0]?.split('#')[0];
  if (path === undefined) return null;
  return SNAP_ASSETS.get(path) ?? null;
}

const CORS = {
  // The wallet fetches these from the extension's own origin.
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Cache-Control': 'no-store',
};

function serve(root: string, request: IncomingMessage, response: ServerResponse): void {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, CORS);
    response.end();
    return;
  }
  const asset = request.method === 'GET' || request.method === 'HEAD' ? snapAsset(request.url) : null;
  if (!asset) {
    response.writeHead(404, { ...CORS, 'Content-Type': 'text/plain' });
    response.end('Not found');
    return;
  }
  const body = readFileSync(`${root}/${asset.file}`);
  response.writeHead(200, { ...CORS, 'Content-Type': asset.type });
  response.end(request.method === 'HEAD' ? undefined : body);
}

function sameBytes(one: Uint8Array, other: Uint8Array): boolean {
  if (one.length !== other.length) return false;
  return one.every((byte, index) => byte === other[index]);
}

/**
 * What to do when something else already holds the port.
 *
 * The id cannot move, so a second server is not an option. Another process
 * serving the same bytes is the same Snap and is left alone; anything else is
 * an operator's decision, not ours.
 */
export async function assertSnapServed(root: string, port: number): Promise<void> {
  for (const [path, asset] of SNAP_ASSETS) {
    const expected = readFileSync(`${root}/${asset.file}`);
    let served: Uint8Array;
    try {
      // A port held by something that never answers must not hold up the dev
      // server either.
      const answer = await fetch(`http://${SNAP_HOST}:${port}${path}`, {
        signal: AbortSignal.timeout(REPLY_TIMEOUT_MS),
      });
      if (!answer.ok) throw new Error(`answered ${answer.status}`);
      served = new Uint8Array(await answer.arrayBuffer());
    } catch (cause) {
      throw new Error(
        `Port ${port} is taken, and whatever holds it did not serve ${path}: ${String(cause)}. Stop that process, then start the dev server again.`,
        { cause },
      );
    }
    if (!sameBytes(expected, served)) {
      throw new Error(
        `Port ${port} is taken by something serving a different ${path}. The Snap id cannot move to another port, so stop that process, then start the dev server again.`,
      );
    }
  }
}

function listen(root: string, port: number): Promise<Server | null> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => serve(root, request, response));
    server.once('error', (cause) => {
      if ((cause as { code?: string }).code !== 'EADDRINUSE') {
        reject(cause);
        return;
      }
      // Something already serves this id. Reuse it only where it is this Snap.
      assertSnapServed(root, port).then(() => resolve(null), reject);
    });
    // Docker exposes this listener through a loopback-only published port.
    server.listen(port, process.env['DEX_SNAP_BIND_HOST'] ?? SNAP_HOST, () => resolve(server));
  });
}

/**
 * The listener, which belongs to the process rather than to one dev server.
 *
 * A restart builds the server that takes over before it closes the one leaving,
 * and a config reload loads this module again, so a listener owned by either
 * one alone is either closed under the new server's feet or left behind. One
 * record per port, counted by how many dev servers want it, is what survives
 * both. The key is shared deliberately, so a second copy of this module finds
 * the same record.
 */
interface SnapListener {
  /** Resolves with null where another process already serves this Snap, which we never close. */
  readonly pending: Promise<Server | null>;
  users: number;
}

const LISTENERS = Symbol.for('canton-dex.canton-snap-server');

function listeners(): Map<number, SnapListener> {
  const host = globalThis as { [LISTENERS]?: Map<number, SnapListener> };
  host[LISTENERS] ??= new Map();
  return host[LISTENERS];
}

async function acquire(root: string, port: number): Promise<void> {
  const held = listeners().get(port);
  if (held) {
    held.users += 1;
    // The listener may still be coming up, and this caller needs it serving.
    await held.pending;
    return;
  }
  // Recorded as it starts, so a second dev server asking at the same time
  // waits for this one rather than binding the port twice.
  const pending = listen(root, port);
  listeners().set(port, { pending, users: 1 });
  try {
    await pending;
  } catch (cause) {
    listeners().delete(port);
    throw cause;
  }
}

async function release(port: number): Promise<void> {
  const held = listeners().get(port);
  if (!held) return;
  held.users -= 1;
  if (held.users > 0) return;
  listeners().delete(port);
  const server = await held.pending.catch(() => null);
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
}

/**
 * Serves the development Snap with the dev server, and nowhere else.
 *
 * It starts only where the environment asked for the local Snap, which is the
 * Keycloak development mode. A production build, a test run, the demo and the
 * published Snap all leave it inert, and it closes the listener it started when
 * the dev server goes away.
 */
export function cantonSnapServer(): Plugin {
  let root = '';
  let port = 0;
  /**
   * How many dev servers this instance holds the listener for. A restart uses
   * one instance for two servers where the configuration did not change, and a
   * fresh instance for each where it did, so both are counted the same way.
   */
  let held = 0;

  return {
    name: 'canton-snap-dev-server',
    apply: 'serve',

    configResolved(config: ResolvedConfig) {
      root = config.root;
      // The same rule the application uses, so one place decides what "local"
      // means. An unusable value throws here, before anything starts. Nothing
      // names a local Snap outside the development environment, which is what
      // keeps this inert for the demo, for a build and for a test run.
      const target = resolveSnapTarget(config.env['VITE_SNAP_ID'] as string | undefined, true);
      port = config.command === 'serve' && target.local ? snapPort(target) : 0;
    },

    async configureServer() {
      if (port === 0) return;
      await acquire(root, port);
      held += 1;
    },

    /**
     * Vite waits for this while it closes a dev server, and calls it once for
     * each, which is what pairs it with `configureServer`. `closeBundle` runs
     * once per environment instead, so it would give the port up twice.
     *
     * One dev server letting go is not the end of the listener: in a restart
     * the server taking over has already asked for it, because Vite builds the
     * new one before it closes the old. The last one to leave closes it.
     */
    async buildEnd() {
      if (held === 0) return;
      held -= 1;
      await release(port);
    },
  };
}
