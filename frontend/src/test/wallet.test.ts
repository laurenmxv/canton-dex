import { describe, expect, it, vi } from 'vitest';
import {
  base64ToHex,
  bytesToBase64,
  hexToBase64,
  hexToBytes,
  keyAlgorithm,
} from '../wallet/encoding';
import { createMetaMaskWallet, injectedMetaMask } from '../wallet/metamask';
import {
  PUBLISHED_SNAP,
  PUBLISHED_SNAP_ID as SNAP_ID,
  resolveSnapTarget,
  SNAP_VERSION,
} from '../wallet/snap';
import { WalletError, type SnapTarget } from '../wallet/types';

/** The development Snap this repository's Keycloak environment names. */
const LOCAL_SNAP: SnapTarget = { snapId: 'local:http://localhost:4040', version: '1.0.0', local: true };

/** The Snap's own multihash form: 0x1220 then a 32-byte digest. */
const MULTIHASH_HEX = `1220${'ab'.repeat(32)}`;
const MULTIHASH_BASE64 = hexToBase64(MULTIHASH_HEX);
/** A secp256k1 SPKI, as `compressedPubKeyToSPKIDer` builds one. */
const SECP_SPKI_HEX = `3036301006072a8648ce3d020106052b8104000a032200${'02'}${'11'.repeat(32)}`;
/** An Ed25519 SPKI, as the offline script produced. */
const ED_SPKI_HEX = `302a300506032b6570032100${'22'.repeat(32)}`;
const DER_SIGNATURE_HEX = `3044022011${'00'.repeat(31)}022022${'00'.repeat(31)}`;

type Request = { method: string; params?: unknown };

interface FakeProvider {
  isMetaMask?: boolean;
  request(request: Request): Promise<unknown>;
}

function recorder(handle: (request: Request) => unknown, isMetaMask = true) {
  const calls: Request[] = [];
  const provider: FakeProvider = {
    isMetaMask,
    request: async (request: Request) => {
      calls.push(request);
      return handle(request);
    },
  };
  return { provider, calls };
}

/** A window with EIP-6963 announcements, an injected provider, or both. */
function browser({
  announced = [],
  ethereum,
}: {
  announced?: { rdns: string; provider: unknown }[];
  ethereum?: unknown;
}): Window {
  const listeners: ((event: Event) => void)[] = [];
  return {
    addEventListener: (_: string, listener: (event: Event) => void) => listeners.push(listener),
    removeEventListener: () => {},
    dispatchEvent: () => {
      for (const listener of listeners) {
        for (const one of announced) {
          listener(
            new CustomEvent('eip6963:announceProvider', {
              detail: { info: { rdns: one.rdns, name: one.rdns }, provider: one.provider },
            }),
          );
        }
      }
      return true;
    },
    ethereum,
  } as unknown as Window;
}

function metamask(handle: (request: Request) => unknown) {
  const { provider, calls } = recorder(handle);
  return { scope: browser({ ethereum: provider }), calls };
}

/** The shape MetaMask answers with for one installed Snap. */
function installedSnap(target: SnapTarget, overrides: Record<string, unknown> = {}) {
  return {
    id: target.snapId,
    version: target.version,
    enabled: true,
    blocked: false,
    initialPermissions: { snap_getEntropy: {} },
    ...overrides,
  };
}

function snapAnswers(request: Request): unknown {
  // Nothing connected yet, which is what sends the wallet to install.
  if (request.method === 'wallet_getSnaps') return {};
  if (request.method === 'wallet_requestSnaps') {
    return { [SNAP_ID]: installedSnap(PUBLISHED_SNAP) };
  }
  const invoked = (request.params as { request: { method: string } }).request;
  if (invoked.method === 'canton_getPublicKey') {
    return { compressedPubKey: '0x02', spkiDer: `0x${SECP_SPKI_HEX}`, fingerprint: '1220aa' };
  }
  if (invoked.method === 'canton_signTopology') {
    return { derSignature: `0x${DER_SIGNATURE_HEX}`, fingerprint: '1220aa' };
  }
  throw new Error(`Unexpected ${invoked.method}`);
}

/** Answers as an installed wallet would, for whichever Snap it was asked about. */
function answersFor(target: SnapTarget, clientVersion = 'MetaMask/v13.49.0') {
  return (request: Request): unknown => {
    if (request.method === 'web3_clientVersion') return clientVersion;
    if (request.method === 'wallet_getSnaps') return {};
    if (request.method === 'wallet_requestSnaps') {
      return { [target.snapId]: installedSnap(target) };
    }
    return snapAnswers(request);
  };
}

const FLASK_VERSION = 'MetaMask/v12.14.2-flask.0';

describe('which snap this build installs', () => {
  it('installs the published one unless told otherwise', () => {
    expect(resolveSnapTarget(undefined, true)).toEqual(PUBLISHED_SNAP);
    expect(resolveSnapTarget('', true)).toEqual(PUBLISHED_SNAP);
    expect(resolveSnapTarget(SNAP_ID, false)).toEqual(PUBLISHED_SNAP);
    expect(PUBLISHED_SNAP).toEqual({ snapId: SNAP_ID, version: SNAP_VERSION, local: false });
  });

  it('accepts a loopback development snap while developing', () => {
    expect(resolveSnapTarget('local:http://localhost:4040', true)).toEqual(LOCAL_SNAP);
    expect(resolveSnapTarget(' local:http://127.0.0.1:4040 ', true)).toEqual({
      snapId: 'local:http://127.0.0.1:4040',
      version: SNAP_VERSION,
      local: true,
    });
  });

  it.each([
    ['a built app', 'local:http://localhost:4040', false],
    ['a remote host', 'local:http://snap.example.com', true],
    ['a trailing slash, which is another id', 'local:http://localhost:4040/', true],
    ['another package', 'npm:@someone/other-snap', true],
    ['a plain URL', 'http://localhost:4040', true],
  ])('refuses %s rather than choosing for the reader', (_name, configured, development) => {
    expect(() => resolveSnapTarget(configured, development)).toThrow(TypeError);
  });
});

describe('choosing between MetaMask and Flask', () => {
  it('sends a local snap to Flask while both are announced', async () => {
    const flask = recorder(answersFor(LOCAL_SNAP, FLASK_VERSION));
    const stable = recorder(answersFor(PUBLISHED_SNAP));
    const scope = browser({
      announced: [
        { rdns: 'io.metamask', provider: stable.provider },
        { rdns: 'io.metamask.flask', provider: flask.provider },
      ],
      ethereum: stable.provider,
    });

    await createMetaMaskWallet(scope, LOCAL_SNAP).connect();

    expect(flask.calls.map((call) => call.method)).toEqual([
      'wallet_getSnaps',
      'wallet_requestSnaps',
    ]);
    expect(stable.calls).toHaveLength(0);
  });

  it('keeps the published snap on MetaMask while both are announced', async () => {
    const flask = recorder(answersFor(PUBLISHED_SNAP, FLASK_VERSION));
    const stable = recorder(answersFor(PUBLISHED_SNAP));
    // Another wallet holds `window.ethereum`, which is why the announcement
    // decides rather than whoever injected last.
    const other = recorder(() => null, false);
    const scope = browser({
      announced: [
        { rdns: 'com.brave.wallet', provider: other.provider },
        { rdns: 'io.metamask', provider: stable.provider },
        { rdns: 'io.metamask.flask', provider: flask.provider },
      ],
      ethereum: other.provider,
    });

    await createMetaMaskWallet(scope).connect();

    expect(stable.calls.map((call) => call.method)).toEqual([
      'wallet_getSnaps',
      'wallet_requestSnaps',
    ]);
    expect(flask.calls).toHaveLength(0);
    expect(other.calls).toHaveLength(0);
  });

  it('refuses to hand a local snap to stable MetaMask', async () => {
    const stable = recorder(answersFor(LOCAL_SNAP));
    const scope = browser({
      announced: [{ rdns: 'io.metamask', provider: stable.provider }],
      ethereum: stable.provider,
    });

    const error = (await createMetaMaskWallet(scope, LOCAL_SNAP)
      .connect()
      .catch((cause: unknown) => cause)) as WalletError;

    expect(error.kind).toBe('missing');
    expect(error.message).toMatch(/Flask/);
    expect(stable.calls.map((call) => call.method)).not.toContain('wallet_requestSnaps');
  });

  it('accepts an injected Flask that names itself, for a build that announces nothing', async () => {
    const flask = recorder(answersFor(LOCAL_SNAP, FLASK_VERSION));
    const scope = browser({ ethereum: flask.provider });

    await createMetaMaskWallet(scope, LOCAL_SNAP).connect();

    expect(flask.calls.map((call) => call.method)).toEqual([
      'web3_clientVersion',
      'wallet_getSnaps',
      'wallet_requestSnaps',
    ]);
  });

  it('asks nothing of a browser with no wallet at all', async () => {
    const error = (await createMetaMaskWallet(browser({}), LOCAL_SNAP)
      .connect()
      .catch((cause: unknown) => cause)) as WalletError;

    expect(error.kind).toBe('missing');
    expect(error.message).toMatch(/Flask/);
  });
});

describe('the id it installs and the id it invokes', () => {
  it('are the local one, everywhere, once configured', async () => {
    const flask = recorder(answersFor(LOCAL_SNAP, FLASK_VERSION));
    const scope = browser({
      announced: [{ rdns: 'io.metamask.flask', provider: flask.provider }],
    });
    const wallet = createMetaMaskWallet(scope, LOCAL_SNAP);

    expect(wallet.target).toEqual(LOCAL_SNAP);
    await wallet.connect();
    await wallet.publicKey(0);
    await wallet.signTopology(MULTIHASH_BASE64, 0);

    const install = flask.calls.find((call) => call.method === 'wallet_requestSnaps');
    const invoked = flask.calls.filter((call) => call.method === 'wallet_invokeSnap');
    expect(install!.params).toEqual({ 'local:http://localhost:4040': { version: '1.0.0' } });
    expect(invoked.map((call) => (call.params as { snapId: string }).snapId)).toEqual([
      'local:http://localhost:4040',
      'local:http://localhost:4040',
    ]);
  });

  it('are the published one by default', async () => {
    const { scope, calls } = metamask(snapAnswers);
    const wallet = createMetaMaskWallet(scope);

    expect(wallet.target).toEqual(PUBLISHED_SNAP);
    await wallet.connect();
    await wallet.publicKey(0);

    const install = calls.find((call) => call.method === 'wallet_requestSnaps');
    const invoked = calls.find((call) => call.method === 'wallet_invokeSnap');
    expect(install!.params).toEqual({ 'npm:@chainsafe/canton-snap': { version: '1.0.0' } });
    expect((invoked!.params as { snapId: string }).snapId).toBe('npm:@chainsafe/canton-snap');
  });
});

describe('a snap the wallet already has', () => {
  /** What `wallet_getSnaps` answers for a Snap this site is connected to. */
  function connected(entry: Record<string, unknown>) {
    return (request: Request): unknown =>
      request.method === 'wallet_getSnaps' ? { [SNAP_ID]: entry } : snapAnswers(request);
  }

  it('is used as it is, with no second install', async () => {
    const { scope, calls } = metamask(connected(installedSnap(PUBLISHED_SNAP)));
    const wallet = createMetaMaskWallet(scope);

    await wallet.connect();
    const key = await wallet.publicKey(0);

    expect(calls.map((call) => call.method)).toEqual(['wallet_getSnaps', 'wallet_invokeSnap']);
    expect(key.fingerprint).toBe('1220aa');
  });

  it('is installed once where the wallet does not have it', async () => {
    const { scope, calls } = metamask(snapAnswers);
    const wallet = createMetaMaskWallet(scope);

    await wallet.connect();
    await wallet.publicKey(0);

    expect(calls.map((call) => call.method)).toEqual([
      'wallet_getSnaps',
      'wallet_requestSnaps',
      'wallet_invokeSnap',
    ]);
  });

  it.each([
    ['another version', installedSnap(PUBLISHED_SNAP, { version: '0.2.0' }), /0\.2\.0/],
    ['a blocked one', installedSnap(PUBLISHED_SNAP, { blocked: true }), /blocked/i],
    ['one turned off', installedSnap(PUBLISHED_SNAP, { enabled: false }), /turned off/i],
    ['another snap under this id', installedSnap(PUBLISHED_SNAP, { id: 'npm:@someone/other' }), /asked for/i],
    ['an entry that names nothing', {}, /asked for/i],
    ['an entry with no version', { id: SNAP_ID, enabled: true, blocked: false }, /needs 1\.0\.0/],
    ['an entry that hides whether it is blocked', { id: SNAP_ID, version: SNAP_VERSION, enabled: true }, /blocked/i],
    ['an entry that hides whether it is on', { id: SNAP_ID, version: SNAP_VERSION, blocked: false }, /turned on/i],
  ])('refuses %s, and invokes nothing', async (_name, entry, expected) => {
    const { scope, calls } = metamask(connected(entry));

    const error = (await createMetaMaskWallet(scope)
      .connect()
      .catch((cause: unknown) => cause)) as WalletError;

    expect(error.kind).toBe('snap');
    expect(error.message).toMatch(expected);
    expect(calls.map((call) => call.method)).toEqual(['wallet_getSnaps']);
  });

  it.each([
    ['no answer', null],
    ['a list that is not one', 'snaps'],
  ])('refuses %s to wallet_getSnaps without installing', async (_name, answer) => {
    const { scope, calls } = metamask((request) =>
      request.method === 'wallet_getSnaps' ? answer : snapAnswers(request),
    );

    await expect(createMetaMaskWallet(scope).connect()).rejects.toMatchObject({ kind: 'response' });
    expect(calls.map((call) => call.method)).toEqual(['wallet_getSnaps']);
  });

  it('refuses an entry that is not an object at all', async () => {
    const { scope } = metamask((request) =>
      request.method === 'wallet_getSnaps' ? { [SNAP_ID]: 'installed' } : snapAnswers(request),
    );

    await expect(createMetaMaskWallet(scope).connect()).rejects.toMatchObject({ kind: 'response' });
  });

  it('says so when the wallet will not answer what it has', async () => {
    const { scope, calls } = metamask((request) => {
      if (request.method === 'wallet_getSnaps') throw new Error('MetaMask is locked');
      return snapAnswers(request);
    });

    const error = (await createMetaMaskWallet(scope)
      .connect()
      .catch((cause: unknown) => cause)) as WalletError;

    expect(error.kind).toBe('snap');
    expect(error.message).toContain('MetaMask is locked');
    expect(calls.map((call) => call.method)).toEqual(['wallet_getSnaps']);
  });

  it('installs nothing more once the reader dismisses the install', async () => {
    const { scope, calls } = metamask((request) => {
      if (request.method === 'wallet_getSnaps') return {};
      throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
    });

    const error = (await createMetaMaskWallet(scope)
      .connect()
      .catch((cause: unknown) => cause)) as WalletError;

    expect(error.kind).toBe('rejected');
    expect(calls.map((call) => call.method)).toEqual(['wallet_getSnaps', 'wallet_requestSnaps']);
  });
});

describe('finding the wallet', () => {
  it('takes the injected provider only when it says it is MetaMask', () => {
    const { scope } = metamask(() => null);
    expect(injectedMetaMask(scope)).not.toBeNull();

    expect(injectedMetaMask(browser({ ethereum: { request: async () => null } }))).toBeNull();
    expect(injectedMetaMask(browser({}))).toBeNull();
  });

  it('refuses a wallet that claims to be MetaMask while naming itself', () => {
    const brave = { isMetaMask: true, isBraveWallet: true, request: async () => null };

    expect(injectedMetaMask(browser({ ethereum: brave }))).toBeNull();
  });

  it('picks MetaMask out of a shared providers array', () => {
    const metaMask = { isMetaMask: true, request: async () => null };
    const shared = { request: async () => null, providers: [{ request: async () => null }, metaMask] };

    expect(injectedMetaMask(browser({ ethereum: shared }))).toBe(metaMask);
  });

  it('says so plainly when there is no MetaMask at all', async () => {
    const scope = {
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    } as unknown as Window;

    const error = (await createMetaMaskWallet(scope)
      .connect()
      .catch((cause: unknown) => cause)) as WalletError;
    expect(error.kind).toBe('missing');
    expect(error.message).toMatch(/Install it/);
  });
});

describe('the snap it asks for', () => {
  it('pins the exact published id and version', async () => {
    const { scope, calls } = metamask(snapAnswers);
    await createMetaMaskWallet(scope).connect();

    expect(calls.map((call) => call.method)).toEqual(['wallet_getSnaps', 'wallet_requestSnaps']);
    expect(calls[1]).toEqual({
      method: 'wallet_requestSnaps',
      params: { 'npm:@chainsafe/canton-snap': { version: '1.0.0' } },
    });
  });

  it('invokes the same id, and only the two methods it needs', async () => {
    const { scope, calls } = metamask(snapAnswers);
    const wallet = createMetaMaskWallet(scope);

    await wallet.publicKey(0);
    await wallet.signTopology(MULTIHASH_BASE64, 0);

    const invoked = calls.map((call) => call.params as { snapId: string; request: { method: string } });
    expect(invoked.map((one) => one.snapId)).toEqual([SNAP_ID, SNAP_ID]);
    expect(invoked.map((one) => one.request.method)).toEqual([
      'canton_getPublicKey',
      'canton_signTopology',
    ]);
  });

  it('never reaches for an account, a transaction or a network', async () => {
    const { scope, calls } = metamask(snapAnswers);
    const wallet = createMetaMaskWallet(scope);

    await wallet.connect();
    await wallet.publicKey(0);
    await wallet.signTopology(MULTIHASH_BASE64, 0);

    const methods = calls.map((call) => call.method);
    for (const forbidden of [
      'eth_requestAccounts',
      'eth_accounts',
      'eth_sign',
      'personal_sign',
      'eth_sendTransaction',
      'wallet_switchEthereumChain',
    ]) {
      expect(methods).not.toContain(forbidden);
    }
  });
});

describe('what crosses between the snap and the venue', () => {
  it('hands the venue’s own multihash over, without hashing it again', async () => {
    const { scope, calls } = metamask(snapAnswers);
    await createMetaMaskWallet(scope).signTopology(MULTIHASH_BASE64, 3);

    const sent = (calls[0]!.params as { request: { params: { hash: string; keyIndex: number } } })
      .request.params;
    expect(sent.hash).toBe(`0x${MULTIHASH_HEX}`);
    expect(hexToBytes(sent.hash)).toHaveLength(34);
    expect(sent.keyIndex).toBe(3);
  });

  it('converts the exported key and the signature into what the API stores', async () => {
    const { scope } = metamask(snapAnswers);
    const wallet = createMetaMaskWallet(scope);

    const key = await wallet.publicKey(0);
    expect(key.publicKey).toBe(hexToBase64(SECP_SPKI_HEX));
    expect(base64ToHex(key.publicKey)).toBe(SECP_SPKI_HEX);

    const signed = await wallet.signTopology(MULTIHASH_BASE64, 0);
    expect(signed.signature).toBe(hexToBase64(DER_SIGNATURE_HEX));
    expect(base64ToHex(signed.signature)).toBe(DER_SIGNATURE_HEX);
  });

  it('refuses a key index the snap would reject, before asking it', async () => {
    const { scope, calls } = metamask(snapAnswers);

    await expect(createMetaMaskWallet(scope).publicKey(1001)).rejects.toMatchObject({
      kind: 'response',
    });
    await expect(createMetaMaskWallet(scope).publicKey(-1)).rejects.toMatchObject({
      kind: 'response',
    });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['no answer at all', null],
    ['no key', { fingerprint: '1220aa' }],
    ['a key that is not hex', { spkiDer: 'not-hex', fingerprint: '1220aa' }],
    ['no fingerprint', { spkiDer: `0x${SECP_SPKI_HEX}` }],
  ])('refuses %s from the snap', async (_name, answer) => {
    const { scope } = metamask((request) =>
      request.method === 'wallet_requestSnaps' ? {} : answer,
    );

    await expect(createMetaMaskWallet(scope).publicKey(0)).rejects.toMatchObject({
      kind: 'response',
    });
  });

  it('refuses a signature that is not hex', async () => {
    const { scope } = metamask((request) =>
      request.method === 'wallet_requestSnaps'
        ? {}
        : { derSignature: 'zzzz', fingerprint: '1220aa' },
    );

    await expect(
      createMetaMaskWallet(scope).signTopology(MULTIHASH_BASE64, 0),
    ).rejects.toMatchObject({ kind: 'response' });
  });

  it('refuses a hash the venue sent in a form it cannot read', async () => {
    const { scope, calls } = metamask(snapAnswers);

    await expect(createMetaMaskWallet(scope).signTopology('not base64!!', 0)).rejects.toMatchObject(
      { kind: 'response' },
    );
    expect(calls).toHaveLength(0);
  });
});

describe('when the reader says no', () => {
  it('reports a dismissal as one, not as a failure', async () => {
    const rejection = Object.assign(new Error('User rejected the request.'), { code: 4001 });
    const { scope } = metamask(() => {
      throw rejection;
    });

    const error = (await createMetaMaskWallet(scope)
      .connect()
      .catch((cause: unknown) => cause)) as WalletError;
    expect(error.kind).toBe('rejected');
    expect(error.message).toMatch(/dismissed/i);
  });

  it('reports a refused install with the wallet’s own words', async () => {
    const { scope } = metamask(() => {
      throw new Error('Snap is not allowlisted');
    });

    const error = (await createMetaMaskWallet(scope)
      .connect()
      .catch((cause: unknown) => cause)) as WalletError;
    expect(error.kind).toBe('snap');
    expect(error.message).toContain('Snap is not allowlisted');
  });
});

describe('when MetaMask refuses the snap', () => {
  it('reads the reason out of the serialized RPC error, not [object Object]', async () => {
    // A provider rejects with this shape: a plain object, with the sentence
    // that names the cause nested under the one that says it failed.
    const { scope } = metamask(() => {
      throw {
        code: -32603,
        message: 'Internal JSON-RPC error.',
        data: {
          cause: {
            message:
              'Failed to fetch snap "npm:@chainsafe/canton-snap": Snap icon must be a valid SVG.',
          },
        },
      };
    });

    const error = (await createMetaMaskWallet(scope)
      .connect()
      .catch((cause: unknown) => cause)) as WalletError;
    expect(error.kind).toBe('snap');
    expect(error.message).toContain('Snap icon must be a valid SVG.');
    expect(error.message).toContain('Internal JSON-RPC error.');
    expect(error.message).not.toContain('[object Object]');
  });

  it('reads the reason out of a refusal it answers with rather than throws', async () => {
    const { scope } = metamask((request) =>
      request.method === 'wallet_requestSnaps'
        ? {
            [SNAP_ID]: {
              error: {
                message: 'Failed to fetch snap: Snap icon must be a valid SVG.',
                code: -32603,
              },
            },
          }
        : snapAnswers(request),
    );

    const error = (await createMetaMaskWallet(scope)
      .connect()
      .catch((cause: unknown) => cause)) as WalletError;
    expect(error.kind).toBe('snap');
    expect(error.message).toContain('Snap icon must be a valid SVG.');
    expect(error.message).not.toContain('[object Object]');
  });

  it('says a reason was withheld rather than printing an object', async () => {
    const { scope } = metamask(() => {
      throw { code: -32603 };
    });

    const error = (await createMetaMaskWallet(scope)
      .connect()
      .catch((cause: unknown) => cause)) as WalletError;
    expect(error.message).toContain('no reason given');
    expect(error.message).not.toContain('[object Object]');
  });

  it('says the same sentence once, however many wrappers repeat it', async () => {
    const inner = 'Snap icon must be a valid SVG.';
    const { scope } = metamask(() => {
      throw { message: `Failed: ${inner}`, data: { message: inner, cause: { message: inner } } };
    });

    const error = (await createMetaMaskWallet(scope)
      .connect()
      .catch((cause: unknown) => cause)) as WalletError;
    expect(error.message.match(/Snap icon/g)).toHaveLength(1);
  });

  it.each([
    ['blocked', installedSnap(PUBLISHED_SNAP, { blocked: true }), /blocked/i],
    ['turned off', installedSnap(PUBLISHED_SNAP, { enabled: false }), /turned off/i],
  ])('does not treat a %s snap as a usable one', async (_name, entry, expected) => {
    const { scope } = metamask((request) =>
      request.method === 'wallet_requestSnaps' ? { [SNAP_ID]: entry } : snapAnswers(request),
    );

    const error = (await createMetaMaskWallet(scope)
      .connect()
      .catch((cause: unknown) => cause)) as WalletError;
    expect(error.kind).toBe('snap');
    expect(error.message).toMatch(expected);
  });

  it('does not treat a refusal to install as an install', async () => {
    const { scope, calls } = metamask((request) =>
      request.method === 'wallet_requestSnaps' ? {} : snapAnswers(request),
    );

    await expect(createMetaMaskWallet(scope).connect()).rejects.toMatchObject({ kind: 'snap' });
    expect(calls.map((call) => call.method)).toEqual(['wallet_getSnaps', 'wallet_requestSnaps']);
  });
});

describe('telling one prepared key from another', () => {
  it('knows a wallet key from an offline one', () => {
    expect(keyAlgorithm(hexToBase64(SECP_SPKI_HEX))).toBe('secp256k1');
    expect(keyAlgorithm(hexToBase64(ED_SPKI_HEX))).toBe('ed25519');
  });

  it('says so rather than guessing when it cannot tell', () => {
    expect(keyAlgorithm('not base64!!')).toBe('unknown');
    expect(keyAlgorithm(bytesToBase64(new Uint8Array([1, 2, 3])))).toBe('unknown');
  });
});

describe('the encodings themselves', () => {
  it('round-trip a value without changing a byte', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    expect(hexToBytes(base64ToHex(bytesToBase64(bytes)))).toEqual(bytes);
  });

  it.each(['', 'abc', '0xzz', ' 12 34'])('refuse %s as hex', (value) => {
    expect(() => hexToBytes(value)).toThrow(RangeError);
  });

  it('accepts hex with or without the 0x the snap prints', () => {
    expect(hexToBytes('0x1220')).toEqual(hexToBytes('1220'));
  });
});

describe('the wallet never asks for a secret', () => {
  it('sends no method that could export one', async () => {
    const { scope, calls } = metamask(snapAnswers);
    const wallet = createMetaMaskWallet(scope);
    await wallet.connect();
    await wallet.publicKey(0);
    await wallet.signTopology(MULTIHASH_BASE64, 0);

    const serialized = JSON.stringify(calls);
    expect(serialized).not.toMatch(/private|seed|mnemonic|secret|entropy/i);
    expect(vi.isMockFunction(scope.dispatchEvent)).toBe(false);
  });
});
