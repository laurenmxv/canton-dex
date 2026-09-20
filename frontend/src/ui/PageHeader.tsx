import type { ReactNode } from 'react';

/**
 * The top of a screen: what it is, what it is for, and what can be done from
 * here. Every screen uses the same one, so a reader always finds the title in
 * the same place and the actions in the same corner.
 */
export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  back,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  /** The section this screen belongs to, where that is not obvious. */
  eyebrow?: string;
  /** The way out of a detail screen, back to the list it came from. */
  back?: { label: string; onClick: () => void };
}) {
  return (
    <header className="page-head">
      {back ? (
        <button type="button" className="back-link" onClick={back.onClick}>
          ← {back.label}
        </button>
      ) : null}
      <div className="page-head-row">
        <div>
          {eyebrow ? <span className="page-eyebrow">{eyebrow}</span> : null}
          <h1 className="page-title">{title}</h1>
          {description ? <p className="page-desc">{description}</p> : null}
        </div>
        {actions ? <div className="page-actions">{actions}</div> : null}
      </div>
    </header>
  );
}
