import { Banner } from '@openzeppelin/ui-components';
import { venueErrorCode } from '../../lib/api/types';
import { formatCountdown } from '../../lib/labels';
import { Mono } from '../../ui/Mono';
import { walletMessage } from '../wallet/signing';

/** Submit refusals the venue returns before dispatching, leaving the request PREPARED. */
const REFUSED_BEFORE_DISPATCH = new Set([
  'PREPARATION_EXPIRED',
  'DEADLINE_ELAPSED',
  'POOL_ACCESS_REQUIRED',
]);

const TITLES = new Map([
  ['QUOTE_EXPIRED', 'Quote expired'],
  ['PREPARATION_EXPIRED', 'Signing window closed'],
  ['DEADLINE_ELAPSED', 'Deadline elapsed'],
]);

/** True when a failed submit certainly sent nothing, so a new quote is the way on. */
export function refusedBeforeDispatch(error: unknown): boolean {
  return REFUSED_BEFORE_DISPATCH.has(venueErrorCode(error) ?? '');
}

/**
 * Where a ticket's last request stands. A request already with the venue hides
 * the transport error, which would otherwise read as an invitation to re-sign.
 */
export function TicketNotices({
  error,
  stale,
  unresolved,
  submitted,
}: {
  error: Error | undefined;
  /** The venue refused to prepare this quote again. */
  stale: boolean;
  unresolved: string | undefined;
  submitted: string | undefined;
}) {
  const title = TITLES.get(venueErrorCode(error) ?? '');
  return (
    <>
      {error && !stale && !unresolved ? (
        <Banner
          variant="error"
          title={title}
          size="compact"
          dismissible={false}
        >
          {walletMessage(error)}
        </Banner>
      ) : null}
      {stale ? (
        <Banner variant="warning" size="compact" dismissible={false}>
          This quote already has a request
        </Banner>
      ) : null}
      {unresolved ? (
        <Banner variant="warning" title="Sent, outcome unknown" size="compact" dismissible={false}>
          <Mono>{unresolved}</Mono>
        </Banner>
      ) : null}
      {submitted ? (
        <Banner variant="info" title="Request sent" size="compact" dismissible={false}>
          <Mono>{submitted}</Mono>
        </Banner>
      ) : null}
    </>
  );
}

export function quoteExpiry(quoteExpiresAt: string, now: number) {
  const expired = Date.parse(quoteExpiresAt) <= now;
  return {
    expired,
    item: {
      label: 'Quote expires',
      value: (
        <span aria-live="polite">
          {expired ? 'Expired' : `in ${formatCountdown(quoteExpiresAt, now)}`}
        </span>
      ),
    },
  };
}
