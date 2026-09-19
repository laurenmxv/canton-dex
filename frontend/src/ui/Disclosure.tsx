import type { ReactNode } from 'react';

/** Detail a reader can open when they want it, and ignore when they do not. */
export function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="disclosure">
      <summary className="disclosure-summary">{summary}</summary>
      <div className="disclosure-body stack-sm">{children}</div>
    </details>
  );
}
