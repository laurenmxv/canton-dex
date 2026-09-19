import { useEffect, useRef, useState } from 'react';
import type { Onboarding } from '../../lib/api/types';
import type { BoardNotice } from '../../ui/NoticeBoard';
import { confirmedAttestation } from './progress';

export type NoticeKind = 'approved' | 'rejected' | 'party' | 'attestation';

export type Notice = BoardNotice<NoticeKind>;

// The first reading is a baseline, so opening or reloading a screen announces nothing.
export function noticesBetween(previous: Onboarding | null, current: Onboarding): Notice[] {
  if (previous === null || previous.id !== current.id) return [];
  // Notices persist as onboarding advances; next actions belong in the current-step card.
  const notices: Notice[] = [];

  if (previous.review === null && current.review !== null) {
    notices.push(
      current.review.decision === 'APPROVED'
        ? {
            kind: 'approved',
            title: 'Application approved',
          }
        : {
            kind: 'rejected',
            title: 'Application rejected',
            detail: 'No pool access was granted.',
          },
    );
  }

  if (previous.party?.confirmed !== true && current.party?.confirmed === true) {
    notices.push({
      kind: 'party',
      title: 'Party registered',
      detail: `Your party: ${current.party.partyId}`,
    });
  }

  // A step can confirm before its contract identifier arrives, so the baseline
  // is the identifier itself. Otherwise the notice would be lost in between.
  const attestation = confirmedAttestation(current);
  if (!confirmedAttestation(previous)?.contractId && attestation?.contractId) {
    notices.push({
      kind: 'attestation',
      title: 'KYC attestation confirmed',
      contract: { label: 'Attestation contract', value: attestation.contractId },
    });
  }

  return notices;
}

// Caller changes remount the screen; notices stay in memory so reloads do not replay them.
export function useOnboardingNotices(onboarding: Onboarding | null | undefined): {
  notices: Notice[];
  dismiss: (kind: NoticeKind) => void;
} {
  const previous = useRef<Onboarding | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);

  useEffect(() => {
    if (!onboarding) return;
    const fresh = noticesBetween(previous.current, onboarding);
    previous.current = onboarding;
    if (fresh.length === 0) return;
    setNotices((current) => [
      ...current.filter((notice) => !fresh.some((one) => one.kind === notice.kind)),
      ...fresh,
    ]);
  }, [onboarding]);

  return {
    notices,
    dismiss: (kind) => setNotices((current) => current.filter((notice) => notice.kind !== kind)),
  };
}
