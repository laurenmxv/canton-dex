import { Banner, LoadingButton as Button } from '@openzeppelin/ui-components';
import { useAction } from '../../app/useAsync';
import type { DemoApi } from '../../lib/api/demo';
import type { Onboarding } from '../../lib/api/types';
import { partyStatusLabels, partyStatusTones, shortParty } from '../../lib/labels';
import { Mono } from '../../ui/Mono';
import { StatusBadge } from '../../ui/Badge';
import { DataList } from '../../ui/Card';
import { SimulatedLedgerNotice } from '../../ui/SimulatedLedger';
import { keyAlgorithm } from '../../wallet/encoding';
import type { CantonWallet } from '../../wallet/types';
import { WalletRegistration } from './WalletRegistration';

/**
 * Registering the trader's own external party.
 *
 * The key belongs to the trader's wallet and never reaches this app. This
 * chooses between that wallet and the demo's stand-in for one, and otherwise
 * says why neither applies.
 */
export function PartyRegistration({
  onboarding,
  onChanged,
  demo,
  wallet,
}: {
  onboarding: Onboarding;
  onChanged: () => void;
  /** The demo's own surfaces, where this is the demo. Absent in real mode. */
  demo?: DemoApi;
  /**
   * The reader's own wallet. Absent in the demo, which never reaches for one,
   * so a simulated world can never open MetaMask.
   */
  wallet?: CantonWallet;
}) {
  const party = onboarding.party;

  if (party?.status === 'CONFLICT') {
    return (
      <Banner variant="error" size="compact" dismissible={false}>
        This party already exists. Registration was stopped.
      </Banner>
    );
  }

  if (party?.confirmed) {
    return (
      <DataList
        items={[
          { label: 'Party', value: <Mono>{shortParty(party.partyId)}</Mono> },
          {
            label: 'Registration',
            value: (
              <StatusBadge tone={partyStatusTones[party.status]} label={partyStatusLabels[party.status]} />
            ),
          },
        ]}
      />
    );
  }

  if (onboarding.partyMode !== 'external') {
    return (
      <p className="text-muted-foreground text-xs">Party held by the venue participant</p>
    );
  }

  if (onboarding.review?.decision !== 'APPROVED') {
    return (
      <p className="text-muted-foreground text-xs">Awaiting approval</p>
    );
  }

  // Signing again is not the answer while the venue is still settling the last
  // signature, whichever path produced it.
  if (party && (party.status === 'SUBMITTING' || party.status === 'UNRESOLVED')) {
    return (
      <StatusBadge tone={partyStatusTones[party.status]} dot label={partyStatusLabels[party.status]} />
    );
  }

  if (demo) {
    return <SimulatedRegistration demo={demo} onboarding={onboarding} onChanged={onChanged} />;
  }

  if (!wallet) {
    return <Banner variant="warning" size="compact" dismissible={false}>No wallet configured</Banner>;
  }

  // A key prepared before wallets is the trader's, and nothing here replaces it.
  const prepared = party?.publicKey ?? null;
  if (prepared !== null && keyAlgorithm(prepared) !== 'secp256k1') {
    return (
      <Banner variant="warning" title="Prepared with a key MetaMask cannot sign" size="compact" dismissible={false}>
        Ask the venue to start a new request to register this party from your wallet.
      </Banner>
    );
  }

  return <WalletRegistration onboarding={onboarding} wallet={wallet} onChanged={onChanged} />;
}

/** The demo's stand-in for a wallet. The key and the signature are its own. */
function SimulatedRegistration({
  demo,
  onboarding,
  onChanged,
}: {
  demo: DemoApi;
  onboarding: Onboarding;
  onChanged: () => void;
}) {
  const register = useAction(() => demo.onboarding.registerParty(onboarding.id));

  return (
    <div className="flex flex-col gap-2">
      <SimulatedLedgerNotice />
      {register.error ? <Banner variant="error" size="compact" dismissible={false}>{register.error.message}</Banner> : null}
      <div>
        <Button
          size="sm"
          loading={register.pending}
          disabled={register.pending}
          onClick={async () => {
            if (await register.perform()) onChanged();
          }}
        >
          Simulate registration
        </Button>
      </div>
    </div>
  );
}
