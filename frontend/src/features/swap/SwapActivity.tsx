import { useState } from 'react';
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
import { Badge, Callout } from '../../ui/Badge';
import { Button } from '../../ui/Button';
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
      <CardHeader title="Your requests" />

      {recovering ? (
        <div className="card-pad">
          <Callout tone="warning" title="Sent, not reported yet">
            <span className="mono">{recovering}</span>
          </Callout>
        </div>
      ) : null}

      {reclaim.error ? (
        <div className="card-pad">
          <Callout tone="danger">{walletMessage(reclaim.error)}</Callout>
        </div>
      ) : null}

      {/* One page of requests, not a bare list, so the empty case is the
          page's own empty items, checked below. */}
      <AsyncSection result={activity} label="Loading your requests" rows={3}>
        {(page) =>
          page.items.length === 0 ? (
            <EmptyState title="No requests yet" />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Pool</th>
                  <th className="table-num">Input</th>
                  <th className="table-num">Output</th>
                  <th>Status</th>
                  <th>Settles by</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((swap) => (
                  <SwapRow
                    key={swap.swapId}
                    swap={swap}
                    balances={balances}
                    busy={reclaim.pending && reclaiming === swap.swapId}
                    disabled={reclaim.pending}
                    onReclaim={async () => {
                      setReclaiming(swap.swapId);
                      await reclaim.perform(swap);
                      // A withdrawal moves funds back, so the holdings and the
                      // history are both read again, whatever the answer was.
                      onReclaimed();
                    }}
                  />
                ))}
              </tbody>
            </table>
          )
        }
      </AsyncSection>

      {olderCursor || canShowNewer ? (
        <div className="card-pad">
          <div className="row">
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
        </div>
      ) : null}
    </Card>
  );
}

function SwapRow({
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
  const inSymbol = instrumentLabel(balances, swap.inputInstrument);
  const outSymbol = instrumentLabel(balances, swap.outputInstrument);
  const inDecimals = balanceOf(balances, swap.inputInstrument)?.decimals;
  const outDecimals = balanceOf(balances, swap.outputInstrument)?.decimals;

  return (
    <tr>
      <td>{swap.poolName}</td>
      <td className="table-num tabular">
        {formatExact(swap.amountIn, inDecimals)} {inSymbol}
      </td>
      <td className="table-num tabular">
        {swap.amountOut === null ? (
          // Nothing has been paid. What the request binds is a floor, and
          // saying so keeps a signed minimum from reading as a receipt.
          <span className="muted">
            minimum {formatExact(swap.minOut, outDecimals)} {outSymbol}
          </span>
        ) : (
          <>
            {formatExact(swap.amountOut, outDecimals)} {outSymbol}
          </>
        )}
      </td>
      <td>
        <Badge tone={swapStatusTones[swap.status]} dot={swap.status === 'SETTLING'}>
          {swapStatusLabels[swap.status]}
        </Badge>
      </td>
      <td>{formatDateTime(swap.settlementDeadline)}</td>
      <td>
        <div className="stack-sm">
          {swap.canWithdraw ? (
            <Button size="sm" variant="secondary" loading={busy} disabled={disabled} onClick={onReclaim}>
              Reclaim
            </Button>
          ) : null}
          <Disclosure summary="Show detail">
            <DataList
              items={[
                { label: 'Request', value: <span className="mono">{swap.swapId}</span> },
                {
                  label: 'Queue position',
                  value: swap.arrivalSequence === null ? 'Not queued yet' : String(swap.arrivalSequence),
                },
                {
                  // The venue keeps these identifiers after a settlement
                  // consumes the contracts they name, so they are a record of
                  // what the request created, not of what is locked now.
                  label: 'Allocation references',
                  value:
                    swap.allocationCids.length === 0 ? (
                      'None recorded'
                    ) : (
                      <span className="mono">
                        {swap.allocationCids.map(shortContract).join(', ')}
                      </span>
                    ),
                },
                {
                  label: 'Ledger update',
                  value: swap.updateId ? (
                    <span className="mono">{shortContract(swap.updateId)}</span>
                  ) : (
                    'Not confirmed yet'
                  ),
                },
                ...(swap.error
                  ? [{ label: 'Reported problem', value: `${swap.errorCode ?? ''} ${swap.error}`.trim() }]
                  : []),
              ]}
            />
          </Disclosure>
        </div>
      </td>
    </tr>
  );
}
