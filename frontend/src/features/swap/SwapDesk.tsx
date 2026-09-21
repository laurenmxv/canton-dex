import {
  Banner,
  Button,
  CardContent,
} from '@openzeppelin/ui-components';
import { useEffect, useRef, useState } from 'react';
import { useDexClient, useWallet } from '../../app/runtime';
import { useAsync, useChange } from '../../app/useAsync';
import type { SwapActivity as SwapActivityPage } from '../../lib/api/types';
import { isKeyIndex } from '../../wallet/types';
import { Mono } from '../../ui/Mono';
import { Card, CardHeader, DataList } from '../../ui/Card';
import { Disclosure } from '../../ui/Disclosure';
import { TextControl } from '../../ui/Field';
import { EmptyState, ErrorState, Loading, RefreshFailure } from '../../ui/States';
import { PageHeader } from '../../ui/PageHeader';
import { confirmedPoolIds } from '../onboarding/progress';
import { TestTokens } from '../tokens/TestTokens';
import { useWalletSigner } from '../wallet/signing';
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
  const open = eligiblePools(catalogue.data ?? [], confirmedPoolIds(onboarding.data));
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
    <div className="flex flex-col gap-6 fade-in max-w-3xl">
      <PageHeader
        title="Swap"
        description="The venue prices it, your wallet signs it, and the pool settles it in a batch."
      />

      {wallet === null ? (
        <Banner variant="warning" size="compact" dismissible={false}>No wallet configured</Banner>
      ) : null}

      {catalogue.error && catalogue.data !== undefined ? (
        <RefreshFailure error={catalogue.error} onRetry={catalogue.reload} />
      ) : null}

      {balances.error && balances.data !== undefined ? (
        <RefreshFailure error={balances.error} onRetry={balances.reload} />
      ) : null}

      <TestTokens balances={balances} signer={signer} />

      {selected ? (
        <SwapTicket
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

      <SwapActivity
        activity={activity}
        balances={balances.data?.balances ?? []}
        signer={signer}
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

      {wallet ? (
        <Card>
          <CardHeader title="Signing key" />
          <CardContent className="p-5 flex flex-col gap-2">
            <Disclosure summary="Key details">
              <TextControl
                label="Canton key index"
                type="number"
                min={0}
                max={1000}
                value={String(signer.keyIndex)}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (isKeyIndex(next)) signer.setKeyIndex(next);
                }}
              />
              <DataList
                items={[
                  {
                    label: 'Registered party',
                    value: <Mono>{party?.partyId ?? 'Not registered'}</Mono>,
                  },
                  {
                    label: 'Registered key',
                    value: (
                      <Mono>{party?.publicKeyFingerprint ?? 'Not registered'}</Mono>
                    ),
                  },
                  {
                    label: 'Snap',
                    value: (
                      <Mono>
                        {wallet.target.snapId}@{wallet.target.version}
                      </Mono>
                    ),
                  },
                ]}
              />
            </Disclosure>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
