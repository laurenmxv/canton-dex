import type { OnboardingApplication } from '../../lib/api/types';
import { documentCategoryLabels } from '../../lib/labels';
import { formatSize } from './documents';

/**
 * What an application attached: document metadata for a new request, and
 * references for a historical one, which is all those rows ever carried.
 */
export function DocumentList({ application }: { application: OnboardingApplication }) {
  // Both arrays are part of the contract, but one missing list must not take
  // the whole review screen down with it.
  const documents = application.documents ?? [];
  const references = application.documentReferences ?? [];

  if (documents.length > 0) {
    return (
      <ul className="stack-sm">
        {documents.map((document) => (
          <li key={document.id} className="text-xs">
            {document.fileName}{' '}
            <span className="muted">
              {documentCategoryLabels[document.category]} · {formatSize(document.sizeBytes)}
            </span>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul className="stack-sm">
      {references.map((reference) => (
        <li key={reference} className="mono muted text-xs">
          {reference}
        </li>
      ))}
    </ul>
  );
}
