import type { PoolSummary } from '../../lib/api/types';
import { pairSymbols, poolNameOf, shortContract } from '../../lib/labels';
import { Badge } from '../../ui/Badge';
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
    <ul className="access-grid">
      {poolIds.map((poolId) => {
        const name = poolNameOf(catalogue, poolId);
        return (
          <li key={poolId}>
            {/* A button, so the card answers a click, the Enter key and the
                space bar alike. Everything inside it is phrasing content. */}
            <button
              type="button"
              className="access-card"
              aria-label={`Trade ${name}`}
              onClick={() => onTrade(poolId)}
            >
              <span className="access-head">
                <TokenPair tokens={pairSymbols(name).map((symbol) => ({ symbol }))} />
                <span className="access-name">
                  <span className="pool-name">{name}</span>
                  <span className="muted text-xs mono">{shortContract(poolId)}</span>
                </span>
              </span>
              <span className="access-foot">
                <Badge tone="success">Access confirmed</Badge>
                <span className="access-go" aria-hidden="true">
                  Trade →
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
