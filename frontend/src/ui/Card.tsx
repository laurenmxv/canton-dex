import {
  Card as OzCard,
  CardDescription as OzCardDescription,
  CardHeader as OzCardHeader,
} from '@openzeppelin/ui-components';
import { cn } from '@openzeppelin/ui-utils';
import type { ComponentProps, ReactNode } from 'react';

/**
 * A card, at this venue's own elevation.
 *
 * OpenZeppelin draws a flat card with the widest radius. A trading screen
 * stacks panels inside cards, so this one sits a step above the page and takes
 * the narrower radius, which leaves the inner panels room to differ. The
 * classes are merged, so the two radii never both apply.
 */
export function Card({
  children,
  padded = false,
  className,
  ...rest
}: ComponentProps<'div'> & { padded?: boolean }) {
  return (
    <OzCard
      className={cn('rounded-lg shadow-card', padded && 'p-5', className)}
      {...rest}
    >
      {children}
    </OzCard>
  );
}

/**
 * The top of a card: what it holds, and what can be done to it.
 *
 * OpenZeppelin's `CardTitle` is a styled `div`. A card title is a heading, and
 * a reader moving by headings needs to find it, so this writes a real `h2`.
 */
export function CardHeader({
  title,
  description,
  actions,
  titleId,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /**
   * Names the heading, so a table inside the card can point at it with
   * `aria-labelledby` instead of repeating the words in its own caption.
   * The owner mints it with React's `useId`; a literal would collide if the
   * card were ever mounted twice on one screen.
   */
  titleId?: string;
}) {
  return (
    <OzCardHeader className="flex-row items-center justify-between gap-4 border-b px-5 py-4">
      <div>
        <h2
          {...(titleId ? { id: titleId } : {})}
          className="text-[0.9375rem] leading-tight font-semibold tracking-[-0.01em]"
        >
          {title}
        </h2>
        {description ? (
          <OzCardDescription className="mt-0.5 text-xs">{description}</OzCardDescription>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-3">{actions}</div> : null}
    </OzCardHeader>
  );
}

interface DataListItem {
  label: string;
  value: ReactNode;
}

/**
 * A run of labelled values.
 *
 * `summary` reads down the right edge, for a quote or a receipt, and aligns
 * its figures so a reader can compare them down the column.
 */
export function DataList({
  items,
  variant = 'default',
}: {
  items: DataListItem[];
  variant?: 'default' | 'summary';
}) {
  const summary = variant === 'summary';
  return (
    <dl
      className={
        summary
          ? 'grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 text-xs'
          : 'grid grid-cols-[minmax(8rem,auto)_minmax(0,1fr)] gap-x-5 gap-y-2.5 text-sm'
      }
    >
      {items.map((item) => (
        <div key={item.label} className="contents">
          <dt className="text-muted-foreground text-xs">{item.label}</dt>
          <dd className={summary ? 'text-right tabular-nums' : 'break-words'}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
