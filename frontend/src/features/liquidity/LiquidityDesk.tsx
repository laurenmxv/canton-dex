import { Banner, Button } from '@openzeppelin/ui-components';
import { useState } from 'react';
import { useDexClient, useWallet } from '../../app/runtime';
import { useAsync, useChange } from '../../app/useAsync';
import { Card } from '../../ui/Card';
import { PageHeader } from '../../ui/PageHeader';
import { EmptyState, ErrorState, Loading, RefreshFailure } from '../../ui/States';
import { confirmedPoolIds } from '../onboarding/progress';
import { eligiblePools } from '../swap/terms';
import { TestTokens } from '../tokens/TestTokens';
import { useWalletSigner } from '../wallet/signing';
import { SigningKey } from '../wallet/SigningKey';
import { DepositTicket } from './DepositTicket';
import { LiquidityHistory } from './LiquidityHistory';
import { Positions } from './Positions';
import { lifecycle } from './terms';
import { useRequestHistory } from './useRequestHistory';
import { WithdrawTicket } from './WithdrawTicket';

/** Deposits, redemption and recovery need current pool access; positions and history do not. */
export function LiquidityDesk({ onGoToOnboarding }: { onGoToOnboarding: () => void }) {
  const client = useDexClient();
  const wallet = useWallet();
  const [poolId, setPoolId] = useState('');
  const [redeemingPoolId, setRedeemingPoolId] = useState<string>();

  const onboarding = useAsync((signal) => client.onboarding.mine({ signal }), [client]);
  const catalogue = useAsync((signal) => client.pools.list({ signal }), [client]);
  const balances = useAsync((signal) => client.tokens.balances({ signal }), [client]);
  const positions = useAsync((signal) => client.lp.positions({ signal }), [client]);
  const deposits = useRequestHistory(
    (query, signal) => client.lp.deposits(query, { signal }),
    [client],
  );
  const withdrawals = useRequestHistory(
    (query, signal) => client.lp.withdrawals(query, { signal }),
    [client],
  );

  const party = onboarding.data?.party ?? null;
  const signer = useWalletSigner(wallet, party);
  const openPoolIds = confirmedPoolIds(onboarding.data);
  const open = eligiblePools(catalogue.data ?? [], openPoolIds);
  const selected = open.find((pool) => pool.poolId === poolId) ?? open[0];
  const pool = useAsync(
    (signal) => client.pools.get(selected!.poolId, { signal }),
    [client, selected?.poolId],
    { enabled: selected !== undefined },
  );

  function refreshHoldings() {
    balances.reload();
    positions.reload();
    if (selected) pool.reload();
  }

  // A status change in either history can move holdings, LP and the pool's
  // reserves, whether or not the other history could be read.
  useChange(lifecycle(deposits.activity.data), refreshHoldings);
  useChange(lifecycle(withdrawals.activity.data), refreshHoldings);
  const held = balances.data?.balances ?? [];
  // From the latest read, so a draft checks against what is redeemable now.
  const redeeming = positions.data?.items.find(
    (position) => position.poolId === redeemingPoolId && openPoolIds.includes(position.poolId),
  );

  if (onboarding.loading && onboarding.data === undefined) {
    return <Loading label="Loading your account" />;
  }
  if (onboarding.error && onboarding.data === undefined) {
    return <ErrorState error={onboarding.error} onRetry={onboarding.reload} />;
  }

  return (
    <div className="flex flex-col gap-6 fade-in max-w-5xl">
      <PageHeader title="Liquidity" />

      {wallet === null ? (
        <Banner variant="warning" size="compact" dismissible={false}>
          No wallet configured
        </Banner>
      ) : null}

      {catalogue.error && catalogue.data !== undefined ? (
        <RefreshFailure error={catalogue.error} onRetry={catalogue.reload} />
      ) : null}

      {/* The ticket leads; the balances it spends from sit beside it on a wide screen. */}
      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        {selected ? (
          <DepositTicket
            key={selected.poolId}
            pools={open}
            pool={pool}
            poolId={selected.poolId}
            onPoolId={setPoolId}
            balances={balances}
            signer={signer}
            unresolvedRequestId={deposits.recovering}
            onDispatched={deposits.dispatched}
            onSubmitted={() => {
              deposits.activity.reload();
              refreshHoldings();
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

      <Positions
        positions={positions}
        balances={held}
        openPoolIds={openPoolIds}
        disabled={redeeming !== undefined}
        onWithdraw={(position) => setRedeemingPoolId(position.poolId)}
      />

      {redeeming ? (
        <WithdrawTicket
          key={redeeming.poolId}
          position={redeeming}
          balances={held}
          signer={signer}
          unresolvedRequestId={withdrawals.recovering}
          onDispatched={withdrawals.dispatched}
          onSubmitted={() => {
            withdrawals.activity.reload();
            refreshHoldings();
          }}
          onClose={() => setRedeemingPoolId(undefined)}
        />
      ) : null}

      <LiquidityHistory
        title="Your deposits"
        history={deposits}
        balances={held}
        signer={signer}
        openPoolIds={openPoolIds}
        prepareRecovery={(requestId) => client.lp.prepareDepositCancellation(requestId)}
        submitRecovery={(requestId, input) => client.lp.submitDepositCancellation(requestId, input)}
        onRecovered={() => {
          deposits.activity.reload();
          refreshHoldings();
        }}
      />

      <LiquidityHistory
        title="Your withdrawals"
        history={withdrawals}
        balances={held}
        signer={signer}
        openPoolIds={openPoolIds}
        prepareRecovery={(requestId) => client.lp.prepareWithdrawalCancellation(requestId)}
        submitRecovery={(requestId, input) =>
          client.lp.submitWithdrawalCancellation(requestId, input)
        }
        onRecovered={() => {
          withdrawals.activity.reload();
          refreshHoldings();
        }}
      />

      {wallet ? <SigningKey wallet={wallet} party={party} /> : null}
    </div>
  );
}
