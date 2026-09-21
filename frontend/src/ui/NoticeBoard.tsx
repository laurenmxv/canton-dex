import { Button } from '@openzeppelin/ui-components';
import { CopyField } from './CopyField';
import { Note } from './Note';

/** One thing that happened while the reader was watching. */
export interface BoardNotice<K extends string> {
  kind: K;
  title: string;
  detail?: string;
  /** A contract worth copying from the notice itself, named as it is elsewhere. */
  contract?: { label: string; value: string };
}

export function NoticeBoard<K extends string>({
  notices,
  onDismiss,
}: {
  notices: readonly BoardNotice<K>[];
  onDismiss: (kind: K) => void;
}) {
  return (
    <div className="flex flex-col gap-2" role="status" aria-live="polite" aria-label="Updates">
      {notices.map((notice) => (
        // Every notice is a quiet note: the surrounding region already
        // announces them politely, and an alert inside it would interrupt
        // twice. That rules out OpenZeppelin's banner, which is always an
        // alert.
        <Note key={notice.kind} tone="info" title={notice.title}>
          <div className="flex flex-col gap-2">
            {notice.detail ? <p>{notice.detail}</p> : null}
            {notice.contract ? (
              <CopyField label={notice.contract.label} value={notice.contract.value} />
            ) : null}
            <div>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Dismiss: ${notice.title}`}
                onClick={() => onDismiss(notice.kind)}
              >
                Dismiss
              </Button>
            </div>
          </div>
        </Note>
      ))}
    </div>
  );
}
