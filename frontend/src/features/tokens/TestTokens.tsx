import {
  Banner,
  CardContent,
  DataTable,
  type DataTableColumn,
  LoadingButton as Button,
} from '@openzeppelin/ui-components';
import { NUMERIC } from '../../ui/table';
import { useEffect, useId, useRef, useState } from 'react';
import { useDexClient } from '../../app/runtime';
import { useAction, useAsync, useChange, type AsyncResult } from '../../app/useAsync';
import {
  errorCode,
  type FaucetPreparation,
  type FaucetResult,
  type FaucetStatus,
  type TokenBalance,
  type TokenBalances,
} from '../../lib/api/types';
import { formatExact, isZeroAmount } from '../../lib/decimal';
import { StatusBadge } from '../../ui/Badge';
import { Card, CardHeader } from '../../ui/Card';
import { Disclosure } from '../../ui/Disclosure';
import { AsyncSection, EmptyState, RefreshFailure } from '../../ui/States';
import { walletMessage, type WalletSigner } from '../wallet/signing';

/** The granted bundle, as the wallet dialog and the page both say it. */
function granted(preparation: FaucetPreparation): string {
  return preparation.amounts
    .map((amount) => `${formatExact(amount.amount, amount.decimals)} ${amount.symbol}`)
    .join(', ');
}

/**
 * A balance at its instrument's own precision: a whole satoshi shown to six
 * places would read as nothing.
 */
const BALANCE_COLUMNS: DataTableColumn<TokenBalance>[] = [
  { id: 'token', header: 'Token', cell: (balance) => balance.symbol },
  {
    ...NUMERIC,
    id: 'available',
    header: 'Available',
    cell: (balance) => formatExact(balance.available, balance.decimals),
  },
  {
    ...NUMERIC,
    id: 'locked',
    header: 'Locked',
    cell: (balance) => formatExact(balance.locked, balance.decimals),
  },
];

function keyOf(balance: TokenBalance): string {
  return `${balance.instrument.admin}/${balance.instrument.id}`;
}

/**
 * What is held leads; instruments with nothing held, available or locked, such
 * as the LP of pools never joined, fold away under their own names.
 */
function BalanceList({ balances, titleId }: { balances: readonly TokenBalance[]; titleId: string }) {
  const held = balances.filter((balance) => !isZeroAmount(balance.total));
  const empty = balances.filter((balance) => isZeroAmount(balance.total));
  return (
    <>
      {held.length === 0 ? (
        <EmptyState title="No balances yet" />
      ) : (
        <DataTable
          aria-labelledby={titleId}
          columns={BALANCE_COLUMNS}
          rows={held}
          getRowKey={keyOf}
          className="border-0"
        />
      )}
      {empty.length > 0 ? (
        <CardContent className="px-5 pt-2 pb-4">
          <Disclosure
            summary={`${empty.length} instrument${empty.length === 1 ? '' : 's'} with no balance`}
          >
            <ul className="flex flex-col gap-1">
              {empty.map((balance) => (
                <li key={keyOf(balance)}>{balance.symbol}</li>
              ))}
            </ul>
          </Disclosure>
        </CardContent>
      ) : null}
    </>
  );
}

/**
 * What the trader holds, and the one development claim that seeds it. The
 * claim is granted once per account and signed by the trader's own wallet.
 */
export function TestTokens({
  balances,
  signer,
}: {
  balances: AsyncResult<TokenBalances>;
  signer: WalletSigner;
}) {
  const client = useDexClient();
  const titleId = useId();
  const [prepared, setPrepared] = useState<FaucetPreparation>();
  /**
   * True from a signed claim leaving until the venue answers about it again.
   *
   * The answer that was on screen when the reply was lost is remembered, so a
   * status read that fails, or one still serving that same answer, does not
   * pass for a new one.
   */
  const [unresolved, setUnresolved] = useState(false);
  const answeredWith = useRef<FaucetResult | null>(null);
  const unresolvedNow = useRef(unresolved);
  unresolvedNow.current = unresolved;

  const faucet = useAsync((signal) => client.tokens.faucetStatus({ signal }), [client], {
    pollWhile: (result) =>
      result.status === 'SUBMITTING' ||
      result.status === 'UNRESOLVED' ||
      unresolvedNow.current,
  });

  // One successful read is the venue's own answer, whatever it says, and it is
  // what ends the unknown.
  useEffect(() => {
    if (unresolved && (faucet.data ?? null) !== answeredWith.current) setUnresolved(false);
  }, [faucet.data, unresolved]);

  // A confirmed claim is new holdings, so they are read again rather than
  // waiting for the next thing that happens to refresh them.
  useChange(faucet.data?.status, balances.reload);

  const prepare = useAction(() => client.tokens.prepareFaucetClaim());
  const claim = useAction(async (preparation: FaucetPreparation) => {
    const signature = await signer.sign(preparation, {
      operation: 'Test token claim',
      tokenSymbol: preparation.amounts.map((amount) => amount.symbol).join(', '),
      amount: granted(preparation),
      recipient: preparation.partyId,
    });
    try {
      return await client.tokens.submitFaucetClaim({
        preparationId: preparation.preparationId,
        signature,
      });
    } catch (cause) {
      // The signature has left. Whether the venue took it is its answer to
      // give, so the status is read again rather than a new signature asked for.
      answeredWith.current = faucet.data ?? null;
      setUnresolved(true);
      faucet.reload();
      throw cause;
    }
  });

  // A deployment without development tokens serves no faucet route. There is
  // then nothing to offer, so nothing about one is shown.
  const offered = !(faucet.error && errorCode(faucet.error) === 'NOT_FOUND');
  const status = faucet.data?.status;
  const failure = prepare.error ?? claim.error;
  const notices = Boolean((failure && !unresolved) || unresolved || faucet.error || faucet.data?.error);

  return (
    <Card>
      <CardHeader
        title="Balances"
        titleId={titleId}
        actions={
          offered && status ? (
            <StatusBadge
              tone={status === 'COMPLETED' ? 'success' : 'neutral'}
              label={status === 'COMPLETED' ? 'Test tokens claimed' : 'One test-token claim'}
            />
          ) : null
        }
      />

      <AsyncSection result={balances} label="Loading your balances" rows={3}>
        {(read) => <BalanceList balances={read.balances} titleId={titleId} />}
      </AsyncSection>

      {offered && (notices || hasClaimAction(status, prepared !== undefined, unresolved)) ? (
        <CardContent className="p-5 flex flex-col gap-2">
          {/* A claim already sent explains itself below; the transport failure
              that hid its outcome is not something to act on separately. */}
          {failure && !unresolved ? (
            <Banner variant="error" size="compact" dismissible={false}>{walletMessage(failure)}</Banner>
          ) : null}

          {unresolved ? (
            <Banner variant="warning" size="compact" dismissible={false}>Claim sent, outcome unknown</Banner>
          ) : null}

          {faucet.error ? (
            <RefreshFailure error={faucet.error} onRetry={faucet.reload} />
          ) : null}

          {faucet.data?.error ? (
            <Banner variant="warning" title="The venue reported a problem with your claim" size="compact" dismissible={false}>
              {faucet.data.error}
            </Banner>
          ) : null}

          <Claim
            status={status}
            unresolved={unresolved}
            onCheck={faucet.reload}
            prepared={prepared}
            preparing={prepare.pending}
            signing={claim.pending}
            onPrepare={async () => {
              const result = await prepare.perform();
              if (result) setPrepared(result);
            }}
            onSign={async (preparation) => {
              if (!(await claim.perform(preparation))) return;
              setPrepared(undefined);
              setUnresolved(false);
              faucet.reload();
              balances.reload();
            }}
            onCancel={() => setPrepared(undefined)}
          />
        </CardContent>
      ) : null}
    </Card>
  );
}

/** Whether the claim control has anything to offer, which is also what says
 *  whether its surrounding panel is worth rendering at all. */
function hasClaimAction(
  status: FaucetStatus | undefined,
  prepared: boolean,
  unresolved: boolean,
): boolean {
  if (unresolved) return true;
  if (status === 'COMPLETED') return false;
  return status !== undefined || prepared;
}

/** Where the account's one claim stands, and the one thing to do about it. */
function Claim({
  status,
  unresolved,
  onCheck,
  prepared,
  preparing,
  signing,
  onPrepare,
  onSign,
  onCancel,
}: {
  status: FaucetStatus | undefined;
  /** True while a sent claim has no answer, which is when nothing may be signed. */
  unresolved: boolean;
  onCheck: () => void;
  prepared: FaucetPreparation | undefined;
  preparing: boolean;
  signing: boolean;
  onPrepare: () => void;
  onSign: (preparation: FaucetPreparation) => void;
  onCancel: () => void;
}) {
  if (!hasClaimAction(status, prepared !== undefined, unresolved)) return null;

  // A second signature here could claim twice. The status on screen is the one
  // that was there before the reply went missing, so it decides nothing.
  if (unresolved) {
    return (
      <div className="flex items-center gap-3">
        <Button size="sm" variant="secondary" onClick={onCheck}>
          Check again
        </Button>
      </div>
    );
  }

  if (status === 'SUBMITTING' || status === 'UNRESOLVED') {
    return (
      <p className="text-muted-foreground text-xs">
        {status === 'SUBMITTING' ? 'Submitting' : 'Confirming'}
      </p>
    );
  }

  if (prepared) {
    return (
      <>
        <p className="text-xs">Grants {granted(prepared)}</p>
        <div className="flex items-center gap-3">
          <Button size="sm" loading={signing} onClick={() => onSign(prepared)}>
            Sign in MetaMask
          </Button>
          <Button size="sm" variant="ghost" disabled={signing} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <Button size="sm" variant="secondary" loading={preparing} onClick={onPrepare}>
        Get test tokens
      </Button>
    </div>
  );
}
