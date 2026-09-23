import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@openzeppelin/ui-components';
import type { ReactNode } from 'react';

/**
 * A table row's full detail, opened from a button in the row.
 *
 * The detail gets the dialog's width rather than one cell's, so results and
 * identifiers stay readable and the row stays one line tall. The trigger is
 * what the kit returns focus to on close.
 */
export function DetailDialog({
  title,
  label,
  children,
}: {
  title: string;
  /** The button's accessible name, which says whose detail it opens. */
  label: string;
  children: ReactNode;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" aria-label={label}>
          Details
        </Button>
      </DialogTrigger>
      <DialogContent aria-describedby={undefined} className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
