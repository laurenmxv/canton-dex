import { Button } from '@openzeppelin/ui-components';
import type { PoolSummary } from '../../lib/api/types';
import { pairSymbols, poolNameOf, shortContract } from '../../lib/labels';
import { StatusBadge } from '../../ui/Badge';
import { EmptyState } from '../../ui/States';
import { TokenPair } from '../../ui/TokenLogo';

/**
 * The pools this trader may actually trade.
 *
 * Every card here stands for one confirmed access contract on the ledger. A
 * pool an operator approved, but the ledger has not granted, is not one of
 * them and does not appear.
 *
 * The whole card is the control, and it opens the swap screen on the pool it
 * names rather than on whichever pool that screen would have chosen.
 */
export function PoolAccess({
  poolIds,
  catalogue,
  onTrade,
}: {
  poolIds: readonly string[];
  catalogue: readonly PoolSummary[];
  onTrade: (poolId: string) => void;
}) {
  if (poolIds.length === 0) return <EmptyState title="No pools yet" />;

  return (
    <ul className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-3 px-5 pt-4 pb-5 [&>li]:flex">
      {poolIds.map((poolId) => {
        const name = poolNameOf(catalogue, poolId);
        return (
          <li key={poolId}>
            {/* A button, so the card answers a click, the Enter key and the
                space bar alike. Everything inside it is phrasing content. */}
            <Button
              type="button"
              variant="outline"
              className="group/access h-auto bg-card hover:border-primary-border flex w-full flex-1 flex-col gap-3.5 rounded-md border p-3.5 text-left transition-colors hover:bg-[color-mix(in_oklab,var(--primary-soft)_45%,var(--card))]"
              aria-label={`Trade ${name}`}
              onClick={() => onTrade(poolId)}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <TokenPair tokens={pairSymbols(name).map((symbol) => ({ symbol }))} />
                <span className="flex min-w-0 flex-col [&>*]:truncate">
                  <span className="text-sm font-semibold">{name}</span>
                  <span className="text-muted-foreground text-xs font-mono">{shortContract(poolId)}</span>
                </span>
              </span>
              <span className="mt-auto flex items-center justify-between gap-2">
                <StatusBadge tone="success" label="Access confirmed" />
                <span className="text-muted-foreground group-hover/access:text-primary group-focus-visible/access:text-primary text-xs font-[550] transition-colors" aria-hidden="true">
                  Trade →
                </span>
              </span>
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
