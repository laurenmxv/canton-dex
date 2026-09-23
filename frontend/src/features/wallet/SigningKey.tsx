import { CardContent } from '@openzeppelin/ui-components';
import { useKeyIndex } from '../../app/runtime';
import type { PartyPreparation } from '../../lib/api/types';
import { Card, CardHeader, DataList } from '../../ui/Card';
import { Disclosure } from '../../ui/Disclosure';
import { TextControl } from '../../ui/Field';
import { Mono } from '../../ui/Mono';
import { isKeyIndex, MAX_KEY_INDEX, type CantonWallet } from '../../wallet/types';

/** Which Canton key index the wallet signs with, beside the key the party is registered to. */
export function SigningKey({
  wallet,
  party,
}: {
  wallet: CantonWallet;
  party: PartyPreparation | null;
}) {
  const [keyIndex, setKeyIndex] = useKeyIndex();
  return (
    <Card>
      <CardHeader title="Signing key" />
      <CardContent className="p-5 flex flex-col gap-2">
        <Disclosure summary="Key details">
          <TextControl
            label="Canton key index"
            type="number"
            min={0}
            max={MAX_KEY_INDEX}
            value={String(keyIndex)}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (isKeyIndex(next)) setKeyIndex(next);
            }}
          />
          <DataList
            items={[
              { label: 'Registered party', value: <Mono>{party?.partyId ?? 'Not registered'}</Mono> },
              {
                label: 'Registered key',
                value: <Mono>{party?.publicKeyFingerprint ?? 'Not registered'}</Mono>,
              },
              {
                label: 'Snap',
                value: (
                  <Mono>
                    {wallet.target.snapId}@{wallet.target.version}
                  </Mono>
                ),
              },
            ]}
          />
        </Disclosure>
      </CardContent>
    </Card>
  );
}
