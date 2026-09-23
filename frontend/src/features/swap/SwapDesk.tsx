import { Banner, Button } from '@openzeppelin/ui-components';
import { useEffect, useRef, useState } from 'react';
import { useDexClient, useWallet } from '../../app/runtime';
import { useAsync, useChange } from '../../app/useAsync';
import type { SwapActivity as SwapActivityPage } from '../../lib/api/types';
import { Card } from '../../ui/Card';
import { EmptyState, ErrorState, Loading, RefreshFailure } from '../../ui/States';
import { PageHeader } from '../../ui/PageHeader';
import { confirmedPoolIds } from '../onboarding/progress';
import { TestTokens } from '../tokens/TestTokens';
import { useWalletSigner } from '../wallet/signing';
import { SigningKey } from '../wallet/SigningKey';
import { hasOutstanding, SwapActivity } from './SwapActivity';
import { SwapTicket } from './SwapTicket';
import { eligiblePools } from './terms';

/** How many requests one page of history holds. */
const PAGE_SIZE = 20;

/** True once this page of history carries the request, or there is none to wait for. */
function shows(page: SwapActivityPage | undefined, swapId: string | undefined): boolean {
  if (swapId === undefined) return true;
  return page?.items.some((swap) => swap.swapId === swapId) ?? false;
}

/**
 * Where every request stands, as one value.
 *
 * A change to it is a change the ledger made: a locked input, a settled
 * output, a released reclaim. It is what tells the balances to be read again.
 */
function lifecycle(page: SwapActivityPage | undefined): string | undefined {
  if (!page) return undefined;
  return page.items.map((swap) => `${swap.swapId}:${swap.status}:${swap.amountOut ?? ''}`).join('|');
}

/**
 * The trader's swap screen.
 *
 * Everything on it comes from the venue: which pools are open follows from
 * confirmed pool access on the ledger, balances are read holdings, and every
 * request is one the trader's own wallet signed.
 */
export function SwapDesk({
  onGoToOnboarding,
  initialPoolId,
}: {
  onGoToOnboarding: () => void;
  /**
   * The pool the trader arrived for, from the dashboard. A pool the ledger
   * has not opened to them is ignored, exactly as an unknown one is.
   */
  initialPoolId?: string;
}) {
  const client = useDexClient();
  const wallet = useWallet();
  const [poolId, setPoolId] = useState(initialPoolId ?? '');
  /**
   * The cursor that produced each page after the first.
   *
   * Funds stay reclaimable however old a request is, so history is paged
   * rather than cut off at a depth: every page has a cursor to the next.
   */
  const [trail, setTrail] = useState<readonly string[]>([]);
  /**
   * A request whose submission left but whose outcome never came back.
   *
   * It is read from the venue until it appears, because the signature is
   * already spent: signing again would be a second request, not a retry.
   */
  const [recovering, setRecovering] = useState<string>();
  const recoveringRef = useRef(recovering);
  recoveringRef.current = recovering;

  const onboarding = useAsync((signal) => client.onboarding.mine({ signal }), [client]);
  const catalogue = useAsync((signal) => client.pools.list({ signal }), [client]);
  const balances = useAsync((signal) => client.tokens.balances({ signal }), [client]);
  const cursor = trail.at(-1);
  const activity = useAsync(
    (signal) => client.swaps.activity({ limit: PAGE_SIZE, cursor }, { signal }),
    [client, cursor],
    {
      pollWhile: (page) => hasOutstanding(page) || !shows(page, recoveringRef.current),
    },
  );

  // The ledger moved this trader's funds whenever a request changed, so what
  // they hold is read again rather than assumed.
  useChange(lifecycle(activity.data), balances.reload);

  useEffect(() => {
    if (recovering !== undefined && shows(activity.data, recovering)) setRecovering(undefined);
  }, [activity.data, recovering]);

  const party = onboarding.data?.party ?? null;
  const signer = useWalletSigner(wallet, party);
  const openPoolIds = confirmedPoolIds(onboarding.data);
  const open = eligiblePools(catalogue.data ?? [], openPoolIds);
  // A catalogue that no longer holds the chosen pool must not leave the
  // selection pointing at nothing.
  const selected = open.find((pool) => pool.poolId === poolId) ?? open[0];

  const pool = useAsync(
    (signal) => client.pools.get(selected!.poolId, { signal }),
    [client, selected?.poolId],
    { enabled: selected !== undefined },
  );

  if (onboarding.loading && onboarding.data === undefined) {
    return <Loading label="Loading your account" />;
  }
  if (onboarding.error && onboarding.data === undefined) {
    return <ErrorState error={onboarding.error} onRetry={onboarding.reload} />;
  }

  return (
    <div className="flex flex-col gap-6 fade-in max-w-5xl">
      <PageHeader title="Swap" />

      {wallet === null ? (
        <Banner variant="warning" size="compact" dismissible={false}>No wallet configured</Banner>
      ) : null}

      {catalogue.error && catalogue.data !== undefined ? (
        <RefreshFailure error={catalogue.error} onRetry={catalogue.reload} />
      ) : null}

      {/* The ticket leads; the balances it spends from sit beside it on a wide screen. */}
      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        {selected ? (
          <SwapTicket
            key={selected.poolId}
            pools={open}
            pool={pool}
            poolId={selected.poolId}
            onPoolId={setPoolId}
            balances={balances}
            signer={signer}
            unresolvedSwapId={recovering}
            onDispatched={(swapId) => {
              // The request is now the venue's to report on. It is the newest
              // one, so the history goes back to its first page to find it.
              setRecovering(swapId);
              setTrail([]);
              activity.reload();
            }}
            onSubmitted={() => {
              activity.reload();
              balances.reload();
            }}
          />
        ) : (
          <Card>
            <EmptyState
              title="No pools are open to you"
              action={
                <Button variant="secondary" size="sm" onClick={onGoToOnboarding}>
                  Go to onboarding
                </Button>
              }
            />
          </Card>
        )}
        <TestTokens balances={balances} signer={signer} />
      </div>

      <SwapActivity
        activity={activity}
        balances={balances.data?.balances ?? []}
        signer={signer}
        openPoolIds={openPoolIds}
        recovering={recovering}
        olderCursor={activity.data?.nextCursor ?? undefined}
        canShowNewer={trail.length > 0}
        onShowOlder={(next) => setTrail((seen) => [...seen, next])}
        onShowNewer={() => setTrail((seen) => seen.slice(0, -1))}
        onReclaimed={() => {
          activity.reload();
          balances.reload();
        }}
      />

      {wallet ? <SigningKey wallet={wallet} party={party} /> : null}
    </div>
  );
}
