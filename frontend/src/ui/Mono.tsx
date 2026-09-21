import type { ReactNode } from 'react';

/**
 * A ledger identifier, as the venue writes one: monospace, at the small size,
 * so a reader can compare two of them character by character.
 */
export function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs">{children}</span>;
}
