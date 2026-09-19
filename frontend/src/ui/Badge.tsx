import type { ReactNode } from 'react';
import type { Tone } from '../lib/labels';

export function Badge({
  tone = 'neutral',
  dot = false,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={`badge badge-${tone}`}>
      {dot ? <span className="badge-dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

export function Callout({
  tone,
  title,
  children,
}: {
  tone: 'info' | 'warning' | 'danger' | 'demo';
  title?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`callout callout-${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      <div>
        {title ? <div className="callout-title">{title}</div> : null}
        <div>{children}</div>
      </div>
    </div>
  );
}
