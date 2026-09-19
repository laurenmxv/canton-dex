import { Callout } from './Badge';
import { Button } from './Button';
import { CopyField } from './CopyField';

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
    <div className="stack-sm" role="status" aria-live="polite" aria-label="Updates">
      {notices.map((notice) => (
        // Every notice is `info`: the surrounding region already announces
        // them politely, and an alert inside it would interrupt twice.
        <Callout key={notice.kind} tone="info" title={notice.title}>
          <div className="stack-sm">
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
        </Callout>
      ))}
    </div>
  );
}
