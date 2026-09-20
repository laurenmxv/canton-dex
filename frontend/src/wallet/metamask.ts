import { base64ToBytes, bytesToHex, hexToBase64 } from './encoding';
import { PUBLISHED_SNAP } from './snap';
import {
  isKeyIndex,
  PREPARED_HASH_BYTES,
  WalletError,
  type CantonWallet,
  type SnapTarget,
  type WalletKey,
  type WalletSignature,
} from './types';

/** MetaMask's own EIP-6963 name. Brave Wallet and Phantom announce different ones. */
const METAMASK_RDNS = 'io.metamask';
/** Flask announces itself separately, and installs what MetaMask refuses. */
const FLASK_RDNS = 'io.metamask.flask';

/** MetaMask's code for "the reader said no". */
const USER_REJECTED = 4001;

interface Eip1193Provider {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  isMetaMask?: boolean;
  providers?: Eip1193Provider[];
}

/** Flags other wallets set on themselves while also claiming to be MetaMask. */
const OTHER_WALLET_FLAGS = ['isBraveWallet', 'isPhantom', 'isRabby', 'isCoinbaseWallet'] as const;

function impersonates(provider: Eip1193Provider): boolean {
  const flags = provider as unknown as Record<string, unknown>;
  return OTHER_WALLET_FLAGS.some((flag) => flags[flag] === true);
}

interface AnnouncedProvider {
  info: { rdns: string; name: string };
  provider: Eip1193Provider;
}

/** The provider that names itself, which is the only unambiguous answer. */
function announcedProvider(scope: Window, rdns: string): Eip1193Provider | null {
  const announced: AnnouncedProvider[] = [];
  const collect = (event: Event) => {
    const detail = (event as CustomEvent<AnnouncedProvider>).detail;
    if (detail?.info?.rdns) announced.push(detail);
  };

  scope.addEventListener('eip6963:announceProvider', collect);
  scope.dispatchEvent(new Event('eip6963:requestProvider'));
  scope.removeEventListener('eip6963:announceProvider', collect);

  return announced.find((one) => one.info.rdns === rdns)?.provider ?? null;
}

/**
 * The injected provider, for older builds that announce nothing.
 *
 * Several wallets set `isMetaMask` for compatibility, so one that also names
 * itself is not MetaMask however it answers that flag. This cannot tell Flask
 * from MetaMask; `isFlask` does that, and only where it matters.
 */
export function injectedMetaMask(scope: Window): Eip1193Provider | null {
  const injected = (scope as Window & { ethereum?: Eip1193Provider }).ethereum;
  if (!injected) return null;
  const candidates = injected.providers ?? [injected];
  return candidates.find((one) => one.isMetaMask === true && !impersonates(one)) ?? null;
}

/**
 * Whether an injected provider is Flask.
 *
 * Flask sets `isMetaMask` exactly as MetaMask does, and names itself only in
 * `web3_clientVersion`, as MetaMask's own documentation shows. A provider that
 * will not answer is not treated as Flask.
 */
async function isFlask(provider: Eip1193Provider): Promise<boolean> {
  try {
    const version = await provider.request({ method: 'web3_clientVersion' });
    return typeof version === 'string' && version.toLowerCase().includes('flask');
  } catch {
    return false;
  }
}

const METAMASK_MISSING =
  'MetaMask was not found in this browser. Install it, then reload this page.';
const FLASK_MISSING =
  'MetaMask Flask was not found in this browser. This build installs the Canton Snap from a development server, and only Flask installs one. Install Flask, then reload this page.';

/**
 * The provider this build may talk to, and no other.
 *
 * EIP-6963 is asked first, because several wallets share `window.ethereum` and
 * the first one there is whichever injected last. A local Snap goes to Flask
 * alone: MetaMask refuses it, and handing the request to whatever else answers
 * would ask the wrong wallet for a key.
 */
async function requireProvider(scope: Window, target: SnapTarget): Promise<Eip1193Provider> {
  const discovered = announcedProvider(scope, target.local ? FLASK_RDNS : METAMASK_RDNS);
  if (discovered) return discovered;
  const injected = injectedMetaMask(scope);
  if (injected && (!target.local || (await isFlask(injected)))) return injected;
  throw new WalletError('missing', target.local ? FLASK_MISSING : METAMASK_MISSING);
}

function isRejection(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && (cause as { code?: number }).code === USER_REJECTED;
}

/**
 * Where MetaMask keeps the reason, under the wrapper it rejects with.
 *
 * A provider rejects with a serialized JSON-RPC error rather than an `Error`,
 * and the sentence that names the cause is usually nested: the outer message
 * says only that the request failed. `String()` on one of those prints
 * `[object Object]`, which tells the reader nothing.
 */
const NESTED_FIELDS = ['data', 'cause', 'originalError', 'error'] as const;
const MAX_NESTING = 4;

/** Every message in the tree the provider rejected with, outermost first. */
function messagesIn(cause: unknown, depth = 0): string[] {
  if (depth > MAX_NESTING) return [];
  if (typeof cause === 'string') return [cause];
  if (typeof cause !== 'object' || cause === null) return [];
  const source = cause as Record<string, unknown>;
  const own = typeof source.message === 'string' ? [source.message] : [];
  return NESTED_FIELDS.reduce<string[]>(
    (found, field) => found.concat(messagesIn(source[field], depth + 1)),
    own,
  );
}

function keepMessage(found: string[], candidate: string): void {
  const text = candidate.trim();
  if (text === '' || found.some((seen) => seen.includes(text))) return;
  // A wrapper repeats what it wraps often enough to be worth saying once.
  for (let index = found.length - 1; index >= 0; index -= 1) {
    if (text.includes(found[index]!)) found.splice(index, 1);
  }
  found.push(text);
}

/** What MetaMask said, as plainly as it said it. */
export function describeFailure(cause: unknown): string {
  const found: string[] = [];
  for (const message of messagesIn(cause)) {
    if (found.length >= 3) break;
    keepMessage(found, message);
  }
  if (found.length > 0) return found.join(' ');
  const text = String(cause);
  return text === '[object Object]' ? 'no reason given' : text;
}

/**
 * How the pinned Canton Snap says the reader dismissed one of its own dialogs.
 *
 * It throws a plain `Error` with one of these sentences, so MetaMask reports a
 * failed Snap invocation rather than its own 4001, and there is nothing else
 * in the answer to tell a refusal from a Snap that broke. These four sentences
 * are the Snap's contract, matched exactly rather than searched for.
 */
const SNAP_REFUSALS = [
  'User rejected public key export',
  'User rejected signing',
  'User rejected topology signing',
  'User rejected fingerprint disclosure',
];

function snapRefused(cause: unknown): boolean {
  return messagesIn(cause).some((message) => {
    const text = message.trim();
    return SNAP_REFUSALS.some((refusal) => text === refusal || text.endsWith(`: ${refusal}`));
  });
}

/** Turns whatever the provider threw into something a reader can act on. */
function walletFailure(cause: unknown, whileDoing: string): WalletError {
  if (cause instanceof WalletError) return cause;
  if (isRejection(cause) || snapRefused(cause)) {
    return new WalletError('rejected', 'You dismissed the MetaMask prompt.', { cause });
  }
  return new WalletError('snap', `MetaMask could not ${whileDoing}: ${describeFailure(cause)}`, {
    cause,
  });
}

function readString(source: Record<string, unknown>, field: string): string {
  const value = source[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WalletError('response', `The Canton Snap answered without ${field}.`);
  }
  return value;
}

function readObject(answer: unknown, method: string): Record<string, unknown> {
  if (typeof answer !== 'object' || answer === null) {
    throw new WalletError('response', `The Canton Snap gave no answer to ${method}.`);
  }
  return answer as Record<string, unknown>;
}

interface SnapEntry {
  readonly error?: unknown;
  readonly id?: string;
  readonly version?: string;
  readonly blocked?: boolean;
  readonly enabled?: boolean;
}

/**
 * What MetaMask said about this one Snap, in either answer that describes it.
 *
 * Absent means absent: `wallet_getSnaps` leaves out what is not there. An
 * entry that is present but unreadable is a different thing, and says so.
 */
function readSnapEntry(answer: unknown, method: string, target: SnapTarget): SnapEntry | null {
  const entry = readObject(answer, method)[target.snapId];
  if (entry === undefined) return null;
  if (typeof entry !== 'object' || entry === null) {
    throw new WalletError(
      'response',
      `MetaMask described the Canton Snap in a form this app could not read.`,
    );
  }
  return entry as SnapEntry;
}

/**
 * Whether the Snap MetaMask describes can be used, and nothing weaker.
 *
 * Everything is asserted rather than assumed: the id, the version, and that
 * the Snap is neither blocked nor turned off. A field MetaMask leaves out is
 * not a field that says yes, so an answer that describes nothing is refused
 * like any other unusable one.
 */
function assertUsable(entry: SnapEntry, target: SnapTarget): void {
  if (entry.error) {
    throw new WalletError(
      'snap',
      `MetaMask refused the Canton Snap: ${describeFailure(entry.error)}`,
    );
  }
  if (entry.id !== target.snapId) {
    throw new WalletError(
      'snap',
      `MetaMask answered for ${entry.id ?? 'no Snap this app can name'}, and this app asked for ${target.snapId}.`,
    );
  }
  if (entry.version !== target.version) {
    throw new WalletError(
      'snap',
      `MetaMask has Canton Snap ${entry.version ?? 'of an unnamed version'} installed, and this app needs ${target.version}.`,
    );
  }
  if (entry.blocked !== false) {
    throw new WalletError(
      'snap',
      entry.blocked === true
        ? 'MetaMask has blocked this Snap, so it cannot be used.'
        : 'MetaMask did not say whether this Snap is blocked, so this app will not use it.',
    );
  }
  if (entry.enabled !== true) {
    throw new WalletError(
      'snap',
      entry.enabled === false
        ? 'The Canton Snap is installed but turned off. Turn it on in MetaMask, then try again.'
        : 'MetaMask did not say whether this Snap is turned on, so this app will not use it.',
    );
  }
}

/**
 * The Snap this site already connected to, if any.
 *
 * `wallet_getSnaps` asks the reader for nothing and answers with what is
 * already there, so it is what tells install from reuse.
 */
async function connectedSnap(
  provider: Eip1193Provider,
  target: SnapTarget,
): Promise<SnapEntry | null> {
  let answer: unknown;
  try {
    answer = await provider.request({ method: 'wallet_getSnaps' });
  } catch (cause) {
    throw walletFailure(cause, 'list the Snaps it has');
  }
  return readSnapEntry(answer, 'wallet_getSnaps', target);
}

/** The Snap derives its own keys, so an index out of range is our mistake. */
function requireKeyIndex(keyIndex: number): number {
  if (!isKeyIndex(keyIndex)) {
    throw new WalletError('response', 'Choose a key index between 0 and 1000.');
  }
  return keyIndex;
}

/**
 * MetaMask with the Canton Snap.
 *
 * It asks for no Ethereum account, sends no transaction and switches no
 * network. The two things it does are exporting a Canton public key and
 * signing a hash the venue produced, each behind its own MetaMask
 * confirmation.
 */
export function createMetaMaskWallet(
  scope: Window = window,
  target: SnapTarget = PUBLISHED_SNAP,
): CantonWallet {
  async function invoke(method: string, params: Record<string, unknown>): Promise<unknown> {
    const provider = await requireProvider(scope, target);
    try {
      return await provider.request({
        method: 'wallet_invokeSnap',
        params: { snapId: target.snapId, request: { method, params } },
      });
    } catch (cause) {
      throw walletFailure(cause, `run ${method}`);
    }
  }

  return {
    target,

    async connect() {
      const provider = await requireProvider(scope, target);
      // A Snap already connected to this site is the one to use. Asking to
      // install it again would repeat the wallet's install prompt on every
      // connection, and a local Snap would be fetched again each time.
      const connected = await connectedSnap(provider, target);
      if (connected) {
        assertUsable(connected, target);
        return;
      }
      let answer: unknown;
      try {
        answer = await provider.request({
          method: 'wallet_requestSnaps',
          params: { [target.snapId]: { version: target.version } },
        });
      } catch (cause) {
        throw walletFailure(cause, 'install the Canton Snap');
      }
      // MetaMask reports a per-snap failure in the result rather than by
      // throwing, so a refusal must not read as an install.
      const installed = readSnapEntry(answer, 'wallet_requestSnaps', target);
      if (!installed) throw new WalletError('snap', 'MetaMask did not install the Canton Snap.');
      assertUsable(installed, target);
    },

    async publicKey(keyIndex): Promise<WalletKey> {
      const answer = readObject(
        await invoke('canton_getPublicKey', { keyIndex: requireKeyIndex(keyIndex) }),
        'canton_getPublicKey',
      );
      const spkiDer = readString(answer, 'spkiDer');
      const fingerprint = readString(answer, 'fingerprint');
      try {
        return { publicKey: hexToBase64(spkiDer), fingerprint };
      } catch (cause) {
        throw new WalletError('response', 'The Canton Snap returned a malformed public key.', {
          cause,
        });
      }
    },

    async signTopology(multiHashBase64, keyIndex): Promise<WalletSignature> {
      let hash: string;
      try {
        const bytes = base64ToBytes(multiHashBase64);
        // A SHA-256 multihash: 0x12 0x20 then the 32-byte digest.
        if (bytes.length !== 34 || bytes[0] !== 0x12 || bytes[1] !== 0x20) {
          throw new RangeError('Not a SHA-256 multihash');
        }
        hash = `0x${bytesToHex(bytes)}`;
      } catch (cause) {
        throw new WalletError('response', 'The venue sent a hash this app could not read.', {
          cause,
        });
      }
      // The venue's own 34-byte multihash, passed through. The Snap hashes it
      // internally; hashing it again here would sign the wrong thing.
      const answer = readObject(
        await invoke('canton_signTopology', { hash, keyIndex: requireKeyIndex(keyIndex) }),
        'canton_signTopology',
      );
      return readSignature(answer, 'canton_signTopology');
    },

    async signTransaction(hashBase64, keyIndex, context): Promise<WalletSignature> {
      let hash: string;
      try {
        const bytes = base64ToBytes(hashBase64);
        if (bytes.length !== PREPARED_HASH_BYTES) {
          throw new RangeError(`Expected ${PREPARED_HASH_BYTES} bytes, got ${bytes.length}`);
        }
        hash = `0x${bytesToHex(bytes)}`;
      } catch (cause) {
        throw new WalletError(
          'response',
          'The venue sent a prepared transaction hash this app could not read.',
          { cause },
        );
      }
      // The venue's own 32 bytes, passed through. The Snap applies the SHA-256
      // that ECDSA signing needs; doing it here too would sign the wrong thing.
      const answer = readObject(
        await invoke('canton_signHash', {
          hash,
          keyIndex: requireKeyIndex(keyIndex),
          // Shown in the dialog beside the hash, and marked there as coming
          // from this site rather than from the hash itself. Left out when
          // there is none, so the Snap shows its own raw-hash warning.
          ...(context ? { metadata: context } : {}),
        }),
        'canton_signHash',
      );
      return readSignature(answer, 'canton_signHash');
    },
  };
}

/** The signature and the key that made it, as every signing method answers. */
function readSignature(answer: Record<string, unknown>, method: string): WalletSignature {
  const derSignature = readString(answer, 'derSignature');
  const fingerprint = readString(answer, 'fingerprint');
  try {
    return { signature: hexToBase64(derSignature), fingerprint };
  } catch (cause) {
    throw new WalletError('response', `The Canton Snap returned a malformed ${method} signature.`, {
      cause,
    });
  }
}
