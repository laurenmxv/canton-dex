import { useEffect, useRef, useState } from 'react';
import type { PoolProposalRecord } from '../../lib/api/types';
import type { BoardNotice } from '../../ui/NoticeBoard';

/** Keyed by the proposal and the status it reached, so nothing announces twice. */
export type PoolNotice = BoardNotice<string>;

/** Outcomes the operator did not ask for, and would otherwise have to notice. */
function outcome(proposal: PoolProposalRecord): PoolNotice | null {
  switch (proposal.status) {
    case 'CREATED':
      return {
        kind: `${proposal.proposalId}:CREATED`,
        title: `${proposal.name} created`,
        ...(proposal.poolId ? { contract: { label: 'Pool contract', value: proposal.poolId } } : {}),
      };
    case 'REJECTED':
      return {
        kind: `${proposal.proposalId}:REJECTED`,
        title: `${proposal.name} rejected`,
        detail: proposal.error ?? 'The dvv rejected this proposal.',
      };
    case 'FAILED':
      return {
        kind: `${proposal.proposalId}:FAILED`,
        title: `${proposal.name} failed`,
        detail: proposal.error ?? 'The ledger refused this proposal.',
      };
    default:
      return null;
  }
}

/**
 * What changed between two readings of the queue.
 *
 * A first reading announces nothing, and neither does a proposal seen for the
 * first time: arriving at a screen that already shows an outcome is not news.
 * Only a proposal that changed while the reader was watching is announced.
 */
export function poolNoticesBetween(
  previous: readonly PoolProposalRecord[] | null,
  current: readonly PoolProposalRecord[],
): PoolNotice[] {
  if (previous === null) return [];
  const before = new Map(previous.map((proposal) => [proposal.proposalId, proposal.status]));
  const notices: PoolNotice[] = [];
  for (const proposal of current) {
    const was = before.get(proposal.proposalId);
    if (was === undefined || was === proposal.status) continue;
    const notice = outcome(proposal);
    if (notice) notices.push(notice);
  }
  return notices;
}

/**
 * The notices worth showing right now.
 *
 * Nothing is stored, and the screen holding this is rebuilt when the caller
 * changes, so one operator's announcement can never reach another.
 */
export function usePoolNotices(proposals: readonly PoolProposalRecord[] | undefined): {
  notices: PoolNotice[];
  dismiss: (kind: string) => void;
} {
  const previous = useRef<readonly PoolProposalRecord[] | null>(null);
  const [notices, setNotices] = useState<PoolNotice[]>([]);

  useEffect(() => {
    if (!proposals) return;
    const fresh = poolNoticesBetween(previous.current, proposals);
    previous.current = proposals;
    if (fresh.length === 0) return;
    setNotices((current) => [
      ...current.filter((notice) => !fresh.some((one) => one.kind === notice.kind)),
      ...fresh,
    ]);
  }, [proposals]);

  return {
    notices,
    dismiss: (kind) => setNotices((current) => current.filter((notice) => notice.kind !== kind)),
  };
}
