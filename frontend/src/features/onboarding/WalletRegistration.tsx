import { Banner, LoadingButton as Button } from '@openzeppelin/ui-components';
import { useState } from 'react';
import { useDexClient } from '../../app/runtime';
import { useAction, useLive } from '../../app/useAsync';
import { venueErrorCode, type Onboarding } from '../../lib/api/types';
import { partyStatusLabels, partyStatusTones, shortParty } from '../../lib/labels';
import { Mono } from '../../ui/Mono';
import { StatusBadge } from '../../ui/Badge';
import { DataList } from '../../ui/Card';
import { Disclosure } from '../../ui/Disclosure';
import { TextControl } from '../../ui/Field';
import { isKeyIndex, WalletError, type CantonWallet, type WalletKey } from '../../wallet/types';
import { walletMessage } from '../wallet/signing';

/**
 * Registering the trader's party with MetaMask and the Canton Snap.
 *
 * The wallet holds the key and never gives it up: this asks it to export one
 * public key and to sign one hash the venue produced, each behind MetaMask's
 * own confirmation, and only ever from something the reader clicked.
 */
export function WalletRegistration({
  onboarding,
  wallet,
  onChanged,
}: {
  onboarding: Onboarding;
  wallet: CantonWallet;
  onChanged: () => void;
}) {
  const client = useDexClient();
  const live = useLive();
  const snap = wallet.target;
  const [keyIndex, setKeyIndex] = useState(0);
  const [identity, setIdentity] = useState<WalletKey | null>(null);

  const party = onboarding.party;
  const partyName = onboarding.review?.partyHint ?? onboarding.suggestedPartyHint;

  const connect = useAction(async () => {
    await wallet.connect();
    // An install can outlast the screen that asked for it. Opening a second
    // prompt for a reader who has left is worse than stopping here.
    if (!live()) return null;
    // Exporting the key is what proves the Snap is installed and usable.
    const key = await wallet.publicKey(keyIndex);
    if (!live()) return null;
    setIdentity(key);
    return key;
  });

  const prepare = useAction((key: WalletKey) =>
    client.onboarding.prepareParty(onboarding.id, { publicKey: key.publicKey }),
  );

  const register = useAction(async (prepared: NonNullable<Onboarding['party']>) => {
    if (!identity) throw new WalletError('mismatch', 'Connect MetaMask before signing.');
    // The venue must be signing for the key it already holds, not another one.
    if (prepared.publicKey !== identity.publicKey) {
      throw new WalletError(
        'mismatch',
        'This request was prepared with a different key. Open Key details and choose the index it was prepared with, or ask the venue to start again.',
      );
    }
    if (!prepared.multiHash) {
      throw new WalletError('response', 'The venue has not produced a hash to sign yet.');
    }
    const signed = await wallet.signTopology(prepared.multiHash, keyIndex);
    // MetaMask holds its dialog open across a logout, and what comes back
    // after one belongs to a reader who is gone.
    if (!live()) {
      throw new WalletError('rejected', 'The session ended before this was registered.');
    }
    if (prepared.publicKeyFingerprint && signed.fingerprint !== prepared.publicKeyFingerprint) {
      throw new WalletError(
        'mismatch',
        'MetaMask signed with a different key than the venue prepared. Nothing was submitted.',
      );
    }
    return client.onboarding.confirmParty(onboarding.id, {
      preparationId: prepared.preparationId,
      signature: signed.signature,
    });
  });

  const failure = connect.error ?? prepare.error ?? register.error;
  const busy = connect.pending || prepare.pending || register.pending;

  if (venueErrorCode(register.error) === 'PARTY_ALREADY_EXISTS') {
    return (
      <Banner variant="error" size="compact" dismissible={false}>
        This party already exists. Registration was stopped.
      </Banner>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {snap.local && !identity ? (
        <Banner variant="warning" size="compact" dismissible={false}>This build requires MetaMask Flask.</Banner>
      ) : null}

      <DataList
        items={[
          { label: 'Party name', value: partyName },
          ...(party
            ? [
                { label: 'Party', value: <Mono>{shortParty(party.partyId)}</Mono> },
                {
                  label: 'Hosted by',
                  value: <Mono>{party.participantId ?? 'Not recorded'}</Mono>,
                },
                {
                  label: 'Registration',
                  value: (
                    <StatusBadge tone={partyStatusTones[party.status]} label={partyStatusLabels[party.status]} />
                  ),
                },
              ]
            : []),
        ]}
      />

      {failure ? <Banner variant="error" size="compact" dismissible={false}>{walletMessage(failure)}</Banner> : null}

      <div className="flex items-center gap-3">
        {!identity ? (
          <Button size="sm" loading={connect.pending} disabled={busy} onClick={() => connect.perform()}>
            Connect MetaMask
          </Button>
        ) : !party ? (
          <Button
            size="sm"
            loading={prepare.pending}
            disabled={busy}
            onClick={async () => {
              if (await prepare.perform(identity)) onChanged();
            }}
          >
            Prepare party
          </Button>
        ) : (
          <Button
            size="sm"
            loading={register.pending}
            disabled={busy}
            onClick={async () => {
              await register.perform(party);
              if (live()) onChanged();
            }}
          >
            Sign and register with MetaMask
          </Button>
        )}
      </div>

      <Disclosure summary="Key details">
        {/* Reachable at every step: a preparation made at another index can only be finished here. */}
        <TextControl
          label="Canton key index"
          type="number"
          min={0}
          max={1000}
          value={String(keyIndex)}
          disabled={busy}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (!isKeyIndex(next)) return;
            setKeyIndex(next);
            // The key derived from the previous index goes, and so does what
            // was said about it: a mismatch names an index no longer chosen.
            setIdentity(null);
            connect.clearError();
            prepare.clearError();
            register.clearError();
          }}
        />
        <DataList
          items={[
            {
              label: 'Wallet fingerprint',
              value: <Mono>{identity?.fingerprint ?? 'Not connected'}</Mono>,
            },
            {
              label: 'Snap',
              value: (
                <Mono>
                  {snap.snapId}@{snap.version}
                </Mono>
              ),
            },
            ...(party
              ? [
                  {
                    label: 'Hash to sign',
                    value: <Mono>{party.multiHash ?? 'Not produced'}</Mono>,
                  },
                ]
              : []),
          ]}
        />
      </Disclosure>
    </div>
  );
}
