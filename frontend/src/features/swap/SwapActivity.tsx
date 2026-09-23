import {
  Banner,
  CardContent,
  DataTable,
  LoadingButton as Button,
} from '@openzeppelin/ui-components';
import { NUMERIC } from '../../ui/table';
import { useId, useRef, useState } from 'react';
import { useDexClient } from '../../app/runtime';
import { useAction, useLive, type AsyncResult } from '../../app/useAsync';
import type { Swap, SwapActivity as SwapActivityPage, TokenBalance } from '../../lib/api/types';
import { formatExact } from '../../lib/decimal';
import {
  formatDateTime,
  shortContract,
  swapStatusLabels,
  swapStatusTones,
} from '../../lib/labels';
import { Mono, References } from '../../ui/Mono';
import { StatusBadge } from '../../ui/Badge';
import { Card, CardHeader, DataList } from '../../ui/Card';
import { DetailDialog } from '../../ui/DetailDialog';
import { AsyncSection, EmptyState } from '../../ui/States';
import { walletMessage, type WalletSigner } from '../wallet/signing';
import { lacksPoolAccess } from '../onboarding/progress';
import { balanceOf, instrumentLabel } from './terms';

/** Statuses nothing will move on its own. Everything else is still in flight. */
const SETTLED_FOR_GOOD = new Set<Swap['status']>(['SETTLED', 'WITHDRAWN', 'FAILED']);

/** True while any request on the page can still change, which is when to keep reading. */
export function hasOutstanding(page: SwapActivityPage): boolean {
  return page.items.some((swap) => !SETTLED_FOR_GOOD.has(swap.status));
}

/** The instrument's own precision, where the venue reported a balance for it. */
function decimalsOf(
  balances: readonly TokenBalance[],
  instrument: Swap['inputInstrument'],
): number | undefined {
  return balanceOf(balances, instrument)?.decimals;
}

/**
 * Every request this trader ever signed, newest first.
 *
 * It is read from the venue rather than from anything the browser kept, so a
 * reload, a new tab or another machine all show the same history. A settled
 * request reports what was actually paid, which can exceed the minimum signed
 * for; nothing here derives it. Only a pool the trader's access opens offers a
 * reclaim.
 */
export function SwapActivity({
  activity,
  balances,
  signer,
  openPoolIds,
  recovering,
  olderCursor,
  canShowNewer,
  onShowOlder,
  onShowNewer,
  onReclaimed,
}: {
  activity: AsyncResult<SwapActivityPage>;
  balances: readonly TokenBalance[];
  signer: WalletSigner;
  openPoolIds: readonly string[];
  /** A request that was sent but has not appeared here yet. */
  recovering: string | undefined;
  /** The cursor to the page before this one, where there is one. */
  olderCursor: string | undefined;
  canShowNewer: boolean;
  onShowOlder: (cursor: string) => void;
  onShowNewer: () => void;
  onReclaimed: () => void;
}) {
  const swapActivityTitle = useId();
  const client = useDexClient();
  const live = useLive();
  const currentPoolIds = useRef(openPoolIds);
  currentPoolIds.current = openPoolIds;
  const canReclaim = (poolId: string) => live() && currentPoolIds.current.includes(poolId);
  const [reclaiming, setReclaiming] = useState<string>();

  const reclaim = useAction(async (swap: Swap) => {
    if (!canReclaim(swap.poolId)) return;
    const prepared = await client.swaps.prepareCancellation(swap.swapId);
    if (!canReclaim(swap.poolId)) return;
    const symbol = instrumentLabel(balances, swap.inputInstrument);
    const signature = await signer.sign(prepared, {
      operation: 'Reclaim locked input',
      tokenSymbol: symbol,
      amount: `${swap.amountIn} ${symbol}`,
      sender: swap.trader,
    });
    if (!canReclaim(swap.poolId)) return;
    return client.swaps.submitCancellation(swap.swapId, {
      preparationId: prepared.preparationId,
      signature,
    });
  });

  return (
    <Card>
      <CardHeader title="Your swaps" titleId={swapActivityTitle} />

      {recovering ? (
        <CardContent className="p-5">
          <Banner variant="warning" title="Sent, not reported yet" size="compact" dismissible={false}>
            <Mono>{recovering}</Mono>
          </Banner>
        </CardContent>
      ) : null}

      {reclaim.error ? (
        <CardContent className="p-5">
          <Banner variant="error" size="compact" dismissible={false}>{walletMessage(reclaim.error)}</Banner>
        </CardContent>
      ) : null}

      {/* One page of requests, not a bare list, so the empty case is the
          page's own empty items, checked below. */}
      <AsyncSection result={activity} label="Loading your requests" rows={3}>
        {(page) =>
          page.items.length === 0 ? (
            <EmptyState title="No swaps yet" />
          ) : (
            <DataTable
              aria-labelledby={swapActivityTitle}
              columns={[
                { id: 'pool', header: 'Pool', cell: (swap) => swap.poolName },
                {
                  ...NUMERIC,
                  id: 'input',
                  header: 'Input',
                  cell: (swap) =>
                    `${formatExact(swap.amountIn, decimalsOf(balances, swap.inputInstrument))} ${instrumentLabel(balances, swap.inputInstrument)}`,
                },
                {
                  ...NUMERIC,
                  id: 'output',
                  header: 'Output',
                  cell: (swap) => <SwapOutput swap={swap} balances={balances} />,
                },
                {
                  id: 'status',
                  header: 'Status',
                  cell: (swap) => (
                    <StatusBadge
                      tone={swapStatusTones[swap.status]}
                      dot={swap.status === 'SETTLING'}
                      label={swapStatusLabels[swap.status]}
                    />
                  ),
                },
                {
                  id: 'settles-by',
                  header: 'Settles by',
                  cell: (swap) => formatDateTime(swap.settlementDeadline),
                },
                {
                  id: 'detail',
                  header: <span className="sr-only">Detail</span>,
                  cell: (swap) => (
                    <SwapDetail
                      swap={swap}
                      balances={balances}
                      busy={reclaim.pending && reclaiming === swap.swapId}
                      disabled={
                        reclaim.pending || !openPoolIds.includes(swap.poolId) ||
                        (lacksPoolAccess(reclaim.error) && reclaiming === swap.swapId)
                      }
                      onReclaim={async () => {
                        setReclaiming(swap.swapId);
                        await reclaim.perform(swap);
                        // A withdrawal moves funds back, so the holdings and
                        // the history are both read again, whatever the
                        // answer was.
                        onReclaimed();
                      }}
                    />
                  ),
                },
              ]}
              rows={page.items}
              getRowKey={(swap) => swap.swapId}
              className="border-0"
            />
          )
        }
      </AsyncSection>

      {olderCursor || canShowNewer ? (
        <CardContent className="p-5">
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              variant="secondary"
              disabled={!canShowNewer}
              onClick={onShowNewer}
            >
              Newer
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={olderCursor === undefined}
              onClick={() => olderCursor && onShowOlder(olderCursor)}
            >
              Older
            </Button>
          </div>
        </CardContent>
      ) : null}
    </Card>
  );
}

/**
 * What the request bought, or what it still guarantees.
 *
 * Nothing has been paid while `amountOut` is null. What the request binds is a
 * floor, and saying so keeps a signed minimum from reading as a receipt.
 */
function SwapOutput({ swap, balances }: { swap: Swap; balances: readonly TokenBalance[] }) {
  const symbol = instrumentLabel(balances, swap.outputInstrument);
  const decimals = decimalsOf(balances, swap.outputInstrument);
  if (swap.amountOut === null) {
    return (
      <span className="text-muted-foreground">
        minimum {formatExact(swap.minOut, decimals)} {symbol}
      </span>
    );
  }
  return (
    <>
      {formatExact(swap.amountOut, decimals)} {symbol}
    </>
  );
}

function SwapDetail({
  swap,
  balances,
  busy,
  disabled,
  onReclaim,
}: {
  swap: Swap;
  balances: readonly TokenBalance[];
  busy: boolean;
  disabled: boolean;
  onReclaim: () => void;
}) {
  const amount = (value: string, instrument: Swap['inputInstrument']) =>
    `${formatExact(value, decimalsOf(balances, instrument))} ${instrumentLabel(balances, instrument)}`;
  return (
    <div className="flex items-center justify-end gap-2">
      {swap.canWithdraw ? (
        <Button size="sm" variant="secondary" loading={busy} disabled={disabled} onClick={onReclaim}>
          Reclaim
        </Button>
      ) : null}
      <DetailDialog
        title={`${swap.poolName} swap ${shortContract(swap.swapId)}`}
        label={`Details for swap ${shortContract(swap.swapId)}`}
      >
        <DataList
          items={[
            { label: 'Status', value: swapStatusLabels[swap.status] },
            { label: 'Amount in', value: amount(swap.amountIn, swap.inputInstrument) },
            { label: 'Minimum out', value: amount(swap.minOut, swap.outputInstrument) },
            {
              label: 'Paid out',
              value: swap.amountOut === null ? 'Not settled yet' : amount(swap.amountOut, swap.outputInstrument),
            },
            {
              label: 'Expected out, not binding',
              value: amount(swap.expectedOut, swap.outputInstrument),
            },
            { label: 'Request', value: <Mono>{swap.swapId}</Mono> },
            {
              label: 'Arrival',
              value: swap.arrivalSequence === null ? 'Not queued yet' : `#${swap.arrivalSequence}`,
            },
            {
              // The venue keeps these identifiers after a settlement consumes
              // the contracts they name, so they are a record of what the
              // request created, not of what is locked now.
              label: 'Allocation references',
              value:
                swap.allocationCids.length === 0 ? 'None recorded' : <References ids={swap.allocationCids} />,
            },
            {
              label: 'Ledger update',
              value: swap.updateId ? <Mono>{swap.updateId}</Mono> : 'Not confirmed yet',
            },
            ...(swap.error
              ? [{ label: 'Reported problem', value: `${swap.errorCode ?? ''} ${swap.error}`.trim() }]
              : []),
          ]}
        />
      </DetailDialog>
    </div>
  );
}
