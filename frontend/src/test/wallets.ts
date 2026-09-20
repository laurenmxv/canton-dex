import { PUBLISHED_SNAP } from '../wallet/snap';
import type { CantonWallet } from '../wallet/types';

/**
 * A wallet whose every operation refuses, with the few a test needs supplied.
 *
 * A test that reaches for one it did not supply fails by name, which is what
 * tells a screen apart from one that quietly opened a wallet prompt.
 */
export function testWallet(parts: Partial<CantonWallet> = {}): CantonWallet {
  const refuse = (name: string) => () =>
    Promise.reject(new Error(`${name} is not part of this test`));
  return {
    target: PUBLISHED_SNAP,
    connect: refuse('wallet.connect'),
    publicKey: refuse('wallet.publicKey'),
    signTopology: refuse('wallet.signTopology'),
    signTransaction: refuse('wallet.signTransaction'),
    ...parts,
  };
}
