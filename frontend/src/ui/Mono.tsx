import type { ReactNode } from 'react';

/**
 * A ledger identifier, as the venue writes one: monospace, at the small size,
 * so a reader can compare two of them character by character.
 */
export function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs">{children}</span>;
}

/** Several identifiers in full, one per line, so none is cut or run into the next. */
export function References({ ids }: { ids: readonly string[] }) {
  return (
    <span className="flex flex-col wrap-anywhere">
      {ids.map((id) => (
        <Mono key={id}>{id}</Mono>
      ))}
    </span>
  );
}
