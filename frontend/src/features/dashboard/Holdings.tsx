import { useDexClient } from '../../app/runtime';
import { useAsync } from '../../app/useAsync';
import { errorCode, type TokenBalance } from '../../lib/api/types';
import { formatExact, isZeroAmount } from '../../lib/decimal';
import { Card, CardHeader } from '../../ui/Card';
import { AsyncSection, EmptyState } from '../../ui/States';
import { TokenLogo } from '../../ui/TokenLogo';

/** One instrument is its administrator and that administrator's own id for it. */
function keyOf(balance: TokenBalance): string {
  return `${balance.instrument.admin}/${balance.instrument.id}`;
}

/**
 * Empty rows go last, so what the trader holds is what they see first. The
 * sort is stable, so the venue's own order survives inside each group.
 */
function held(balances: readonly TokenBalance[]): TokenBalance[] {
  return [...balances].sort(
    (left, right) => Number(isZeroAmount(left.total)) - Number(isZeroAmount(right.total)),
  );
}

/**
 * What the trader holds, as the ledger reported it at one offset.
 *
 * Available is what a swap can be signed for now. Locked is not gone: an
 * allocation a request made reserves it, and it returns if that request is
 * reclaimed. Nothing here is priced, converted or totalled across
 * instruments, because the venue reports no price for any of them.
 */
export function Holdings() {
  const client = useDexClient();
  const balances = useAsync((signal) => client.tokens.balances({ signal }), [client]);

  // A deployment that serves no balances has none to show, so this says
  // nothing rather than reporting a route as a failure.
  if (balances.data === undefined && errorCode(balances.error) === 'NOT_FOUND') return null;

  return (
    <Card>
      <CardHeader title="Your tokens" />
      <AsyncSection result={balances} label="Loading your balances" rows={3}>
        {(tokens) =>
          tokens.balances.length === 0 ? (
            <EmptyState title="No tokens yet" />
          ) : (
            <ul className="flex flex-col">
              {held(tokens.balances).map((balance) => (
                <Holding key={keyOf(balance)} balance={balance} />
              ))}
            </ul>
          )
        }
      </AsyncSection>
    </Card>
  );
}

function Holding({ balance }: { balance: TokenBalance }) {
  const locked = !isZeroAmount(balance.locked);
  return (
    <li className="flex flex-col gap-1 border-b px-5 py-3 last:border-b-0">
      <div className="flex items-center gap-3">
        <TokenLogo symbol={balance.symbol} seed={keyOf(balance)} />
        <div className="flex min-w-0 flex-1 flex-col [&>*]:truncate">
          <span className="text-sm font-semibold">{balance.symbol}</span>
          <span className="text-muted-foreground text-xs font-mono">{balance.instrument.id}</span>
        </div>
        <div className="flex min-w-0 flex-col items-end text-right">
          {/* At the instrument's own precision: a whole satoshi shown to six
              places would read as nothing. */}
          <span className="text-[0.9375rem] font-semibold tabular-nums">
            {formatExact(balance.available, balance.decimals)}
          </span>
          <span className="text-muted-foreground text-xs">available</span>
        </div>
      </div>
      {/* A request's allocation reserves this. It returns if that request is
          reclaimed, so it is said beside the total rather than subtracted. */}
      {locked ? (
        <p className="text-muted-foreground text-right text-xs tabular-nums">
          {formatExact(balance.locked, balance.decimals)} locked ·{' '}
          {formatExact(balance.total, balance.decimals)} total
        </p>
      ) : null}
    </li>
  );
}
