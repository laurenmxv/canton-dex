import {
  Banner,
  CardContent,
  LoadingButton as Button,
} from '@openzeppelin/ui-components';
import { useEffect, useRef, useState } from 'react';
import { useDexClient, useWallet } from '../../app/runtime';
import { useAction, useAsync } from '../../app/useAsync';
import {
  errorCode,
  type FaucetPreparation,
  type FaucetResult,
  type FaucetStatus,
} from '../../lib/api/types';
import { formatExact } from '../../lib/decimal';
import { StatusBadge } from '../../ui/Badge';
import { Card, CardHeader } from '../../ui/Card';
import { PageHeader } from '../../ui/PageHeader';
import { EmptyState, ErrorState, Loading, RefreshFailure } from '../../ui/States';
import { walletMessage, useWalletSigner } from '../wallet/signing';

/** The granted bundle, as the wallet dialog and the page both say it. */
function granted(preparation: FaucetPreparation): string {
  return preparation.amounts
    .map((amount) => `${formatExact(amount.amount, amount.decimals)} ${amount.symbol}`)
    .join(', ');
}

/** The account's development token claim, signed by its registered wallet. */
export function Faucet() {
  const client = useDexClient();
  const wallet = useWallet();
  const onboarding = useAsync((signal) => client.onboarding.mine({ signal }), [client]);
  const signer = useWalletSigner(wallet, onboarding.data?.party);
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

  // A deployment without development tokens serves no faucet route.
  const offered = !(faucet.error && errorCode(faucet.error) === 'NOT_FOUND');
  const status = faucet.data?.status;
  const failure = prepare.error ?? claim.error;
  const notices = Boolean((failure && !unresolved) || unresolved || faucet.error || faucet.data?.error);

  if (onboarding.loading && onboarding.data === undefined) {
    return <Loading label="Loading your account" />;
  }
  if (onboarding.error && onboarding.data === undefined) {
    return <ErrorState error={onboarding.error} onRetry={onboarding.reload} />;
  }

  return (
    <div className="flex max-w-3xl flex-col gap-6 fade-in">
      <PageHeader title="Faucet" description="Request test tokens for trading." />
      <Card>
        <CardHeader
          title="Test tokens"
          actions={
            offered && status ? (
              <StatusBadge
                tone={status === 'COMPLETED' ? 'success' : 'neutral'}
                label={status === 'COMPLETED' ? 'Test tokens claimed' : 'One test-token claim'}
              />
            ) : null
          }
        />

        {!offered ? <EmptyState title="Faucet unavailable" description="Test tokens are not available in this environment." /> : null}
        {offered && faucet.loading && !faucet.data ? <Loading label="Loading faucet" /> : null}

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
              }}
              onCancel={() => setPrepared(undefined)}
            />
          </CardContent>
        ) : null}
      </Card>
    </div>
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
