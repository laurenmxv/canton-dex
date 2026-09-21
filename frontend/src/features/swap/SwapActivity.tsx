import {
  Banner,
  CardContent,
  DataTable,
  LoadingButton as Button,
} from '@openzeppelin/ui-components';
import { NUMERIC } from '../../ui/table';
import { useId, useState } from 'react';
import { useDexClient } from '../../app/runtime';
import { useAction, type AsyncResult } from '../../app/useAsync';
import type { Swap, SwapActivity as SwapActivityPage, TokenBalance } from '../../lib/api/types';
import { formatExact } from '../../lib/decimal';
import {
  formatDateTime,
  shortContract,
  swapStatusLabels,
  swapStatusTones,
} from '../../lib/labels';
import { Mono } from '../../ui/Mono';
import { StatusBadge } from '../../ui/Badge';
import { Card, CardHeader, DataList } from '../../ui/Card';
import { Disclosure } from '../../ui/Disclosure';
import { AsyncSection, EmptyState } from '../../ui/States';
import { walletMessage, type WalletSigner } from '../wallet/signing';
import { balanceOf, instrumentLabel } from './terms';

/** Statuses nothing will move on its own. Everything else is still in flight. */
const SETTLED_FOR_GOOD = new Set<Swap['status']>(['SETTLED', 'WITHDRAWN', 'FAILED']);

/** True while any request on the page can still change, which is when to keep reading. */
export function hasOutstanding(page: SwapActivityPage): boolean {
  return page.items.some((swap) => !SETTLED_FOR_GOOD.has(swap.status));
}

/**
 * Every request this trader ever signed, newest first.
 *
 * It is read from the venue rather than from anything the browser kept, so a
 * reload, a new tab or another machine all show the same history. A settled
 * request reports what was actually paid, which can exceed the minimum signed
 * for; nothing here derives it.
 */
/** The instrument's own precision, where the venue reported a balance for it. */
function decimalsOf(
  balances: readonly TokenBalance[],
  instrument: Swap['inputInstrument'],
): number | undefined {
  return balanceOf(balances, instrument)?.decimals;
}

export function SwapActivity({
  activity,
  balances,
  signer,
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
  const [reclaiming, setReclaiming] = useState<string>();

  const reclaim = useAction(async (swap: Swap) => {
    const prepared = await client.swaps.prepareCancellation(swap.swapId);
    const symbol = instrumentLabel(balances, swap.inputInstrument);
    const signature = await signer.sign(prepared, {
      operation: 'Reclaim locked input',
      tokenSymbol: symbol,
      amount: `${swap.amountIn} ${symbol}`,
      sender: swap.trader,
    });
    return client.swaps.submitCancellation(swap.swapId, {
      preparationId: prepared.preparationId,
      signature,
    });
  });

  return (
    <Card>
      <CardHeader title="Your requests" titleId={swapActivityTitle} />

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
            <EmptyState title="No requests yet" />
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
                  header: 'Detail',
                  cell: (swap) => (
                    <SwapDetail
                      swap={swap}
                      busy={reclaim.pending && reclaiming === swap.swapId}
                      disabled={reclaim.pending}
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
  busy,
  disabled,
  onReclaim,
}: {
  swap: Swap;
  busy: boolean;
  disabled: boolean;
  onReclaim: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {swap.canWithdraw ? (
        <Button size="sm" variant="secondary" loading={busy} disabled={disabled} onClick={onReclaim}>
          Reclaim
        </Button>
      ) : null}
      <Disclosure summary="Show detail">
        <DataList
          items={[
            { label: 'Request', value: <Mono>{swap.swapId}</Mono> },
            {
              label: 'Queue position',
              value:
                swap.arrivalSequence === null ? 'Not queued yet' : String(swap.arrivalSequence),
            },
            {
              // The venue keeps these identifiers after a settlement consumes
              // the contracts they name, so they are a record of what the
              // request created, not of what is locked now.
              label: 'Allocation references',
              value:
                swap.allocationCids.length === 0 ? (
                  'None recorded'
                ) : (
                  <Mono>
                    {swap.allocationCids.map(shortContract).join(', ')}
                  </Mono>
                ),
            },
            {
              label: 'Ledger update',
              value: swap.updateId ? (
                <Mono>{shortContract(swap.updateId)}</Mono>
              ) : (
                'Not confirmed yet'
              ),
            },
            ...(swap.error
              ? [
                  {
                    label: 'Reported problem',
                    value: `${swap.errorCode ?? ''} ${swap.error}`.trim(),
                  },
                ]
              : []),
          ]}
        />
      </Disclosure>
    </div>
  );
}
