import { useAction } from '../../app/useAsync';
import type { DemoApi } from '../../lib/api/demo';
import type { Onboarding } from '../../lib/api/types';
import { partyStatusLabels, partyStatusTones, shortParty } from '../../lib/labels';
import { Badge, Callout } from '../../ui/Badge';
import { Button } from '../../ui/Button';
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

  if (party?.confirmed) {
    return (
      <DataList
        items={[
          { label: 'Party', value: <span className="mono">{shortParty(party.partyId)}</span> },
          {
            label: 'Registration',
            value: (
              <Badge tone={partyStatusTones[party.status]}>{partyStatusLabels[party.status]}</Badge>
            ),
          },
        ]}
      />
    );
  }

  if (onboarding.partyMode !== 'external') {
    return (
      <p className="muted text-xs">Party held by the venue participant</p>
    );
  }

  if (onboarding.review?.decision !== 'APPROVED') {
    return (
      <p className="muted text-xs">Awaiting approval</p>
    );
  }

  // Signing again is not the answer while the venue is still settling the last
  // signature, whichever path produced it.
  if (party && (party.status === 'SUBMITTING' || party.status === 'UNRESOLVED')) {
    return (
      <Badge tone={partyStatusTones[party.status]} dot>
        {partyStatusLabels[party.status]}
      </Badge>
    );
  }

  if (demo) {
    return <SimulatedRegistration demo={demo} onboarding={onboarding} onChanged={onChanged} />;
  }

  if (!wallet) {
    return <Callout tone="warning">No wallet configured</Callout>;
  }

  // A key prepared before wallets is the trader's, and nothing here replaces it.
  const prepared = party?.publicKey ?? null;
  if (prepared !== null && keyAlgorithm(prepared) !== 'secp256k1') {
    return (
      <Callout tone="warning" title="Prepared with a key MetaMask cannot sign">
        Ask the venue to start a new request to register this party from your wallet.
      </Callout>
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
    <div className="stack-sm">
      <SimulatedLedgerNotice />
      {register.error ? <Callout tone="danger">{register.error.message}</Callout> : null}
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
