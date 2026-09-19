import type { DocumentCategory, OnboardingDocument } from '../../lib/api/types';

/**
 * The documents an applicant can attach.
 *
 * There is no upload route and no file ever leaves the browser: the venue
 * stores metadata describing a document it would ask for. Every screen showing
 * these says so.
 */
export interface DocumentTemplate {
  key: string;
  category: DocumentCategory;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
}

export const documentTemplates: DocumentTemplate[] = [
  {
    key: 'passport',
    category: 'IDENTITY',
    fileName: 'passport.pdf',
    mediaType: 'application/pdf',
    sizeBytes: 182_311,
  },
  {
    key: 'incorporation',
    category: 'IDENTITY',
    fileName: 'certificate-of-incorporation.pdf',
    mediaType: 'application/pdf',
    sizeBytes: 264_902,
  },
  {
    key: 'utility-bill',
    category: 'ADDRESS',
    fileName: 'utility-bill.pdf',
    mediaType: 'application/pdf',
    sizeBytes: 96_540,
  },
  {
    key: 'lease',
    category: 'ADDRESS',
    fileName: 'office-lease.pdf',
    mediaType: 'application/pdf',
    sizeBytes: 421_775,
  },
  {
    key: 'source-of-funds',
    category: 'OTHER',
    fileName: 'source-of-funds.pdf',
    mediaType: 'application/pdf',
    sizeBytes: 154_223,
  },
];

/** Turns a chosen template into the metadata entry the venue stores. */
export function toDocument(template: DocumentTemplate): OnboardingDocument {
  return {
    id: crypto.randomUUID(),
    category: template.category,
    fileName: template.fileName,
    mediaType: template.mediaType,
    sizeBytes: template.sizeBytes,
    simulated: true,
  };
}

export function formatSize(bytes: number): string {
  const kilobytes = bytes / 1024;
  return kilobytes >= 1024
    ? `${(kilobytes / 1024).toFixed(1)} MB`
    : `${Math.round(kilobytes)} KB`;
}
