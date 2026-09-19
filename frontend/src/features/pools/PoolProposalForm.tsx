import { useState } from 'react';
import { useDexClient } from '../../app/runtime';
import { useAction, useAsync } from '../../app/useAsync';
import type { PoolProposalRecord } from '../../lib/api/types';
import { errorCode } from '../../lib/api/types';
import { Callout } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card, CardHeader, DataList } from '../../ui/Card';
import { Disclosure } from '../../ui/Disclosure';
import { SelectField, TextField } from '../../ui/Field';
import { SkeletonRows } from '../../ui/States';
import {
  draftErrors,
  emptyDraft,
  suggestedIds,
  toProposal,
  type DraftField,
  type ProposalDraft,
} from './poolForm';

/** Fields the operator only fills in to override what the pair implies. */
const SUGGESTED: DraftField[] = ['name', 'baseAccountId', 'quoteAccountId', 'lpTokenId'];

export function PoolProposalForm({
  onClose,
  onProposed,
}: {
  onClose: () => void;
  onProposed: (proposal: PoolProposalRecord) => void;
}) {
  const client = useDexClient();
  const options = useAsync((signal) => client.admin.poolCreationOptions({ signal }), [client]);
  const [draft, setDraft] = useState<ProposalDraft>(emptyDraft());
  /** Fields the operator wrote themselves, which a suggestion must not overwrite. */
  const [written, setWritten] = useState<Set<DraftField>>(new Set());
  const [touched, setTouched] = useState(false);
  const [reviewing, setReviewing] = useState(false);

  const admins = options.data?.instrumentAdmins ?? [];
  const ready = { ...draft, ...applySuggestions(draft, written) };
  const errors = draftErrors(ready);
  const invalid = Object.keys(errors).length > 0;

  const submit = useAction(() => client.admin.createPoolProposal(toProposal(ready)));

  function set(field: DraftField, value: string) {
    submit.clearError();
    setDraft((current) => ({ ...current, [field]: value }));
    if (SUGGESTED.includes(field)) {
      setWritten((current) => new Set(current).add(field));
    }
  }

  function field(name: DraftField, label: string, extra: { hint?: string; type?: string } = {}) {
    return (
      <TextField
        label={label}
        value={ready[name]}
        error={touched ? errors[name] : undefined}
        onChange={(event) => set(name, event.target.value)}
        {...extra}
      />
    );
  }

  function adminField(name: 'baseAdmin' | 'quoteAdmin', label: string) {
    return (
      <SelectField
        label={label}
        value={ready[name]}
        error={touched ? errors[name] : undefined}
        onChange={(event) => set(name, event.target.value)}
      >
        <option value="">Select an admin</option>
        {admins.map((admin) => (
          <option key={admin.partyId} value={admin.partyId}>
            {admin.label}
          </option>
        ))}
      </SelectField>
    );
  }

  async function propose() {
    setTouched(true);
    if (invalid) return;
    const created = await submit.perform();
    if (created) onProposed(created);
  }

  const conflict = errorCode(submit.error) === 'CONFLICT';

  return (
    <Card>
      <CardHeader
        title="New proposal"
        actions={
          <Button size="sm" variant="ghost" onClick={onClose} disabled={submit.pending}>
            Cancel
          </Button>
        }
      />
      <div className="card-pad stack">
        {options.error ? (
          <Callout tone="warning" title="Could not load the instrument admins">
            {options.error.message}{' '}
            <button type="button" className="table-link" onClick={options.reload}>
              Try again
            </button>
          </Callout>
        ) : options.loading && !options.data ? (
          <SkeletonRows rows={2} label="Loading pool settings" />
        ) : null}

        <div className="grid-2">
          {adminField('baseAdmin', 'Base admin')}
          {field('baseId', 'Base instrument', { hint: 'The admin’s own id, such as USDC.' })}
          {adminField('quoteAdmin', 'Quote admin')}
          {field('quoteId', 'Quote instrument')}
        </div>

        {field('name', 'Pool name')}

        <div className="grid-2">
          {field('feeBps', 'Fee, bps')}
          {field('lpTokenSupply', 'LP supply')}
          {field('baseReserve', 'Base reserve')}
          {field('quoteReserve', 'Quote reserve')}
        </div>

        <p className="muted text-xs">Accounting reserves. No holdings are funded.</p>

        <Disclosure summary="Advanced">
          <div className="grid-2">
            {field('baseAccountId', 'Base account')}
            {field('quoteAccountId', 'Quote account')}
            {field('lpTokenId', 'LP token')}
          </div>
          {options.data ? (
            <DataList
              items={[
                { label: 'dvv', value: <span className="mono">{options.data.dvv}</span> },
                { label: 'Factory', value: <span className="mono">{options.data.factoryId}</span> },
              ]}
            />
          ) : null}
        </Disclosure>

        {submit.error ? (
          <Callout tone={conflict ? 'warning' : 'danger'} title={conflict ? 'Already taken' : undefined}>
            {submit.error.message}
          </Callout>
        ) : null}

        {reviewing ? (
          <Card padded>
            <DataList
              items={[
                { label: 'Pair', value: `${ready.baseId} / ${ready.quoteId}` },
                { label: 'Name', value: ready.name },
                { label: 'Fee', value: `${ready.feeBps} bps` },
                { label: 'Reserves', value: `${ready.baseReserve} / ${ready.quoteReserve}` },
                { label: 'LP supply', value: ready.lpTokenSupply },
                { label: 'LP token', value: <span className="mono">{ready.lpTokenId}</span> },
              ]}
            />
            <div className="row" style={{ marginTop: '0.75rem' }}>
              <Button loading={submit.pending} disabled={submit.pending} onClick={propose}>
                Submit proposal
              </Button>
              <Button variant="ghost" disabled={submit.pending} onClick={() => setReviewing(false)}>
                Edit
              </Button>
            </div>
          </Card>
        ) : (
          <div className="row">
            <Button
              onClick={() => {
                setTouched(true);
                if (!invalid) setReviewing(true);
              }}
            >
              Review
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

/** A suggestion only fills a field the operator has not written in. */
function applySuggestions(
  draft: ProposalDraft,
  written: ReadonlySet<DraftField>,
): Partial<ProposalDraft> {
  const suggested = suggestedIds(draft);
  const filled: Partial<ProposalDraft> = {};
  for (const field of SUGGESTED) {
    if (written.has(field)) continue;
    const value = suggested[field as keyof typeof suggested];
    if (value) filled[field] = value;
  }
  return filled;
}
