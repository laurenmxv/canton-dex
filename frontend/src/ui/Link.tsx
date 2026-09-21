import { Button } from '@openzeppelin/ui-components';
import { cn } from '@openzeppelin/ui-utils';
import type { ReactNode } from 'react';

/**
 * Text that leads somewhere: a row that opens a record, a way back from a
 * failed read.
 *
 * It is the kit's link button, which brings the focus ring and the disabled
 * handling with it. The colours are the venue's own: the rule underneath is
 * the border colour, and turns to the text colour under the pointer, so a
 * column of these reads as text until the reader goes looking.
 */
export function TextLink({
  children,
  onClick,
  className,
}: {
  children: ReactNode;
  onClick: () => void;
  className?: string;
}) {
  return (
    <Button
      type="button"
      variant="link"
      size="sm"
      className={cn(
        'text-foreground decoration-border hover:decoration-current hover:text-primary h-auto p-0 underline underline-offset-[3px]',
        className,
      )}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
