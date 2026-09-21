import { Alert, AlertDescription, AlertTitle } from '@openzeppelin/ui-components';
import type { ReactNode } from 'react';

type NoteTone = 'info' | 'demo';

const TONE: Record<NoteTone, string> = {
  info: 'bg-info-soft border-[color-mix(in_oklab,var(--info)_28%,transparent)]',
  demo: 'bg-primary-soft border-primary-border',
};

/**
 * A standing note: what this screen is, or what its identifiers are worth.
 *
 * This is the kit's `Alert` without the alert. The component sets
 * `role="alert"` before it spreads the props it was given, so passing `role`
 * replaces it. These notes are on the screen before the reader arrives and
 * never change, so announcing them on every load would interrupt whatever
 * else is being read, and the ones inside the notice board sit in a polite
 * live region that already announces them once.
 */
export function Note({
  tone = 'info',
  title,
  children,
}: {
  tone?: NoteTone;
  title?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Alert role={undefined} className={`px-3.5 py-3 text-xs leading-normal ${TONE[tone]}`}>
      {title ? <AlertTitle className="mb-0.5 font-semibold">{title}</AlertTitle> : null}
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
