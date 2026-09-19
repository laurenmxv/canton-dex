import { useEffect, useState } from 'react';
import { Button } from './Button';

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
    const timer = setTimeout(() => setCopied(false), 2_000);
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
    <div className="copy-field">
      <div className="row-between">
        <span className="field-label">{label}</span>
        <Button size="sm" variant="ghost" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="copy-value">{value}</pre>
    </div>
  );
}
