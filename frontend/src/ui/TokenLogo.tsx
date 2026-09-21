import type { CSSProperties } from 'react';

/** A token as a mark can be drawn for it: what to letter it, and what to derive its colour from. */
export interface TokenMark {
  symbol: string;
  /** The instrument's own identity, where the caller has it. The symbol alone otherwise. */
  seed?: string;
}

type Size = 'sm' | 'md';

/** FNV-1a, so one instrument always draws the same mark in every session. */
function hashOf(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function monogram(symbol: string): string {
  const letters = symbol.replace(/[^A-Za-z0-9]/g, '');
  return (letters.slice(0, 2) || '?').toUpperCase();
}

/**
 * A mark for a token that has none.
 *
 * A Canton instrument carries no logo, so this draws one from the instrument's
 * own identity: the same administrator and id always produce the same colour
 * and the same letters. It stands for the instrument on screen, and it is not
 * an issuer's brand. The symbol is written beside it in text, so a reader
 * never has to read the mark.
 */
export function TokenLogo({ symbol, seed, size = 'md' }: TokenMark & { size?: Size }) {
  const hue = hashOf(seed ?? symbol) % 360;
  return (
    <span
      className={`inline-grid flex-none place-items-center rounded-full font-bold tracking-[0.01em] text-[oklch(0.99_0_0)] ${
        size === 'md' ? 'size-[1.875rem] text-[0.625rem]' : 'size-[1.375rem] text-[0.5rem]'
      }`}
      style={
        {
          '--token-hue': hue,
          backgroundImage:
            'linear-gradient(145deg, oklch(0.68 0.15 var(--token-hue)), oklch(0.52 0.17 calc(var(--token-hue) + 32)))',
        } as CSSProperties
      }
      aria-hidden="true"
    >
      {monogram(symbol)}
    </span>
  );
}

/**
 * The marks of a pool's two sides, overlapped the way a pair is written.
 *
 * The second mark keeps a ring of the card behind it, so the two stay
 * separable where they overlap.
 */
export function TokenPair({ tokens, size = 'md' }: { tokens: readonly TokenMark[]; size?: Size }) {
  return (
    <span className="inline-flex flex-none items-center [&>*+*]:-ml-2 [&>*+*]:ring-2 [&>*+*]:ring-card">
      {tokens.map((token, index) => (
        <TokenLogo
          key={`${token.seed ?? token.symbol}-${index}`}
          symbol={token.symbol}
          seed={token.seed}
          size={size}
        />
      ))}
    </span>
  );
}
