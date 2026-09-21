import { Button } from '@openzeppelin/ui-components';
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
    <header className="mb-1">
      {back ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="text-muted-foreground hover:text-foreground mb-3 h-auto gap-1.5 p-0 text-xs hover:no-underline"
          onClick={back.onClick}
        >
          <span aria-hidden="true">←</span> {back.label}
        </Button>
      ) : null}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          {eyebrow ? (
            <span className="text-primary mb-1.5 block text-[0.6875rem] font-semibold tracking-[0.1em] uppercase">
              {eyebrow}
            </span>
          ) : null}
          <h1 className="tracking-[-0.02em]">{title}</h1>
          {description ? (
            <p className="text-muted-foreground mt-1 max-w-[46rem] text-sm">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2.5">{actions}</div> : null}
      </div>
    </header>
  );
}
