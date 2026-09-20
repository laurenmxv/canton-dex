/** Why the wallet could not do what was asked, at the level a reader can act on. */
export type WalletErrorKind =
  | 'missing'
  | 'rejected'
  | 'snap'
  | 'response'
  | 'mismatch';

/**
 * The only error the wallet adapter throws.
 *
 * Nothing it carries comes from the wallet's own storage: a rejection is a
 * rejection, and a refused install says so without pretending anything
 * succeeded.
 */
export class WalletError extends Error {
  readonly kind: WalletErrorKind;

  constructor(kind: WalletErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WalletError';
    this.kind = kind;
  }
}

/**
 * Which Snap a build installs, and where it comes from.
 *
 * MetaMask derives a Snap's keys from its id, so two ids are two identities
 * even behind one wallet seed. Every screen reads this rather than a constant,
 * so what is installed and what is shown can never differ.
 */
export interface SnapTarget {
  readonly snapId: string;
  readonly version: string;
  /** True for a Snap served from a development server rather than from npm. */
  readonly local: boolean;
}

/** A Canton identity the wallet derives, as the venue's API stores it. */
export interface WalletKey {
  /** Canonical DER X.509 SubjectPublicKeyInfo, base64. */
  publicKey: string;
  fingerprint: string;
}

export interface WalletSignature {
  /** ASN.1 DER ECDSA, base64. */
  signature: string;
  fingerprint: string;
}

/**
 * What the wallet dialog tells the reader a hash stands for.
 *
 * It is the venue's own description of the transaction it prepared. The Snap
 * cannot check any of it against the hash, and says so in the dialog, so this
 * never replaces reading the terms on the page before approving.
 */
export interface SigningContext {
  /** What is being authorized, such as `Swap` or `Reclaim`. */
  operation: string;
  tokenSymbol: string;
  amount: string;
  recipient?: string;
  sender?: string;
}

/** Canton's interactive submission hash: SHA-256, and 32 bytes exactly. */
export const PREPARED_HASH_BYTES = 32;

/**
 * What the venue's screens need from a wallet, and nothing more.
 *
 * No Ethereum account, no network and no transaction is built here: this
 * exports one public key and signs two kinds of hash the venue produced. The
 * seed and the private key never leave the wallet, and nothing here asks for
 * them.
 */
export interface CantonWallet {
  /** The Snap this wallet installs and invokes. */
  readonly target: SnapTarget;
  /** Connects MetaMask and installs the pinned Canton Snap. */
  connect(): Promise<void>;
  /** The Canton identity at this key index. Asks the reader to confirm. */
  publicKey(keyIndex: number): Promise<WalletKey>;
  /**
   * Signs the venue's own multihash. It is passed through untouched: this
   * never hashes anything, and the wallet dialog shows a hash, not the
   * topology it stands for.
   */
  signTopology(multiHashBase64: string, keyIndex: number): Promise<WalletSignature>;
  /**
   * Signs a participant's prepared-transaction hash, also passed through
   * untouched.
   *
   * This is a different hash from a topology one: it is 32 bare bytes rather
   * than a multihash, and it stands for a Daml transaction the backend built
   * and kept. Nothing here rebuilds or re-hashes that transaction, so what is
   * signed is exactly what the participant will be given back.
   */
  signTransaction(
    preparedTransactionHashBase64: string,
    keyIndex: number,
    context?: SigningContext,
  ): Promise<WalletSignature>;
}

/** The venue's own bounds on a Canton key index, as the Snap enforces them. */
export const MAX_KEY_INDEX = 1000;

export function isKeyIndex(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_KEY_INDEX;
}
