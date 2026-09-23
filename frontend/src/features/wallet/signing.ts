import { useCallback } from 'react';
import { useKeyIndex } from '../../app/runtime';
import { useLive } from '../../app/useAsync';
import type { PartyPreparation } from '../../lib/api/types';
import { WalletError, type CantonWallet, type SigningContext } from '../../wallet/types';

/**
 * The hashing scheme this app is willing to approve.
 *
 * V3 binds the transaction's maximum record time into the hash, which is what
 * stops a signature from being replayed outside the window the trader saw. A
 * preparation under any other scheme means something this build cannot state,
 * so it is refused rather than put in front of a wallet.
 */
const REQUIRED_HASHING_SCHEME_VERSION = 3;

/** The part of every venue preparation a wallet needs. */
interface PreparedSigning {
  preparedTransactionHash: string;
  hashEncoding: string;
  hashingSchemeVersion: number;
  partyId: string;
  publicKeyFingerprint: string;
  expiresAt: string;
}

/** The Snap refuses a dialog line longer than this, so every caller is held to it here. */
const CONTEXT_LIMIT = 200;

function bounded(context: SigningContext): SigningContext {
  const cut = (value: string | undefined) =>
    value === undefined ? undefined : value.slice(0, CONTEXT_LIMIT);
  return {
    operation: context.operation.slice(0, CONTEXT_LIMIT),
    tokenSymbol: context.tokenSymbol.slice(0, CONTEXT_LIMIT),
    amount: context.amount.slice(0, CONTEXT_LIMIT),
    recipient: cut(context.recipient),
    sender: cut(context.sender),
  };
}

/** What the reader is told, per reason the wallet gave. */
export function walletMessage(error: Error): string {
  if (!(error instanceof WalletError)) return error.message;
  // A rejection is the one case where saying what did not happen helps.
  return error.kind === 'rejected'
    ? `${error.message} Nothing was sent to the venue.`
    : error.message;
}

export interface WalletSigner {
  /**
   * Opens one wallet prompt and answers with the signature, base64.
   *
   * Everything it checks is checked against the confirmed onboarding, so a
   * preparation for another party, another key or another hashing scheme never
   * reaches the wallet, and a signature from the wrong key never reaches the
   * venue.
   */
  sign: (prepared: PreparedSigning, context: SigningContext) => Promise<string>;
}

/**
 * The one place a venue preparation becomes a signature.
 *
 * The transaction itself stays in the backend: what crosses here is a hash,
 * passed to the wallet unchanged. Nothing in this module builds, rebuilds or
 * re-hashes a Daml transaction, and there is no path through it that produces
 * a signature without the wallet.
 */
export function useWalletSigner(
  wallet: CantonWallet | null,
  party: PartyPreparation | null | undefined,
): WalletSigner {
  const [keyIndex] = useKeyIndex();
  const live = useLive();

  const sign = useCallback(
    async (prepared: PreparedSigning, context: SigningContext): Promise<string> => {
      if (!wallet) {
        throw new WalletError('missing', 'This build has no wallet, so nothing can be signed.');
      }
      if (!party?.confirmed) {
        throw new WalletError(
          'mismatch',
          'Register your party before signing. Only the key it was registered with can authorize this.',
        );
      }
      if (prepared.partyId !== party.partyId) {
        throw new WalletError(
          'mismatch',
          'The venue prepared this for a different party than the one you registered. Nothing was signed.',
        );
      }
      if (prepared.publicKeyFingerprint !== party.publicKeyFingerprint) {
        throw new WalletError(
          'mismatch',
          'The venue prepared this for a different key than the one your party is registered with. Nothing was signed.',
        );
      }
      if (prepared.hashEncoding !== 'base64') {
        throw new WalletError(
          'response',
          `The venue sent its hash as ${prepared.hashEncoding}, and this app reads base64.`,
        );
      }
      if (prepared.hashingSchemeVersion !== REQUIRED_HASHING_SCHEME_VERSION) {
        throw new WalletError(
          'response',
          `The venue used hashing scheme ${prepared.hashingSchemeVersion}, and this app only approves scheme ${REQUIRED_HASHING_SCHEME_VERSION}.`,
        );
      }

      await wallet.connect();
      // An install can outlast the screen that asked for it. Opening a signing
      // prompt for a reader who has left is worse than stopping here.
      if (!live()) {
        throw new WalletError('rejected', 'The session ended before this was signed.');
      }

      const signed = await wallet.signTransaction(
        prepared.preparedTransactionHash,
        keyIndex,
        bounded(context),
      );
      // MetaMask holds its dialog open across a logout, and what comes back
      // after one belongs to a reader who is gone.
      if (!live()) {
        throw new WalletError('rejected', 'The session ended before this was submitted.');
      }
      if (signed.fingerprint !== prepared.publicKeyFingerprint) {
        throw new WalletError(
          'mismatch',
          `MetaMask signed with the key at index ${keyIndex}, and your party is registered to another one. Open Key details, choose the index you registered with, then try again. Nothing was submitted.`,
        );
      }
      return signed.signature;
    },
    [wallet, party, keyIndex, live],
  );

  return { sign };
}
