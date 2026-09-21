import { Button } from '@openzeppelin/ui-components';
import { useEffect, useState } from 'react';

/** How long the button reads "Copied" before it offers to copy again. */
const COPIED_LABEL_MS = 2_000;

/**
 * A value the reader needs whole and exact, with a button that copies it.
 *
 * Nothing is ever read back from the clipboard: copying is the only direction
 * this component moves in.
 */
export function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_LABEL_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // A browser that refuses the clipboard still shows the value to select.
      setCopied(false);
    }
  }

  return (
    <div data-slot="copy-field" className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium">{label}</span>
        <Button size="sm" variant="ghost" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="bg-muted overflow-x-auto rounded-md border px-2.5 py-2 font-mono text-xs leading-normal wrap-anywhere whitespace-pre-wrap">
        {value}
      </pre>
    </div>
  );
}
