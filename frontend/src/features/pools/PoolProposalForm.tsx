import { Banner, Button, LoadingButton, TextField } from '@openzeppelin/ui-components';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useDexClient } from '../../app/runtime';
import { useAction, useAsync } from '../../app/useAsync';
import type { PoolProposalRecord } from '../../lib/api/types';
import { errorCode } from '../../lib/api/types';
import { Mono } from '../../ui/Mono';
import { TextLink } from '../../ui/Link';
import { Card, CardHeader, DataList } from '../../ui/Card';
import { Disclosure } from '../../ui/Disclosure';
import { SelectControl } from '../../ui/Field';
import { SkeletonRows } from '../../ui/States';
import {
  emptyDraft,
  proposalResolver,
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
  /**
   * The draft the operator last put through the venue's rules, or null while
   * they are still editing. Holding the draft rather than a flag is what makes
   * the summary and the submission provably the same values.
   */
  const [reviewed, setReviewed] = useState<ProposalDraft | null>(null);
  /** Fields the operator wrote themselves, which a suggestion must not overwrite. */
  const [written, setWritten] = useState<Set<DraftField>>(new Set());

  const form = useForm<ProposalDraft>({
    defaultValues: emptyDraft(),
    resolver: proposalResolver,
    mode: 'onTouched',
  });
  const { control, getValues, setValue, handleSubmit } = form;

  const admins = options.data?.instrumentAdmins ?? [];
  const submit = useAction((draft: ProposalDraft) =>
    client.admin.createPoolProposal(toProposal(draft)),
  );
  const reviewing = reviewed !== null;

  /**
   * A suggestion only fills a field the operator has not written in.
   *
   * `onUserEdit` fires on a keystroke and never on `setValue`, so a field this
   * writes into stays open to the next suggestion, and one the operator typed
   * into does not.
   */
  function suggest() {
    const suggested = suggestedIds(getValues());
    for (const field of SUGGESTED) {
      if (written.has(field)) continue;
      const value = suggested[field as keyof typeof suggested];
      if (value) setValue(field, value, { shouldValidate: false });
    }
  }

  function claim(field: DraftField) {
    setWritten((current) => new Set(current).add(field));
  }

  function text(name: DraftField, label: string, helperText?: string) {
    return (
      <TextField
        control={control}
        id={`proposal-${name}`}
        name={name}
        label={label}
        {...(helperText === undefined ? {} : { helperText })}
        onUserEdit={() => {
          submit.clearError();
          if (SUGGESTED.includes(name)) claim(name);
          if (name === 'baseId' || name === 'quoteId') queueMicrotask(suggest);
        }}
      />
    );
  }

  /**
   * The instrument admin, on the kit's listbox.
   *
   * The kit's own `SelectField` gives no way to hand React Hook Form the
   * blur and the ref it needs to mark the field touched and to focus it as a
   * first error, so this composes the same listbox parts around a controller.
   */
  function adminField(name: 'baseAdmin' | 'quoteAdmin', label: string) {
    return (
      <Controller
        control={control}
        name={name}
        render={({ field, fieldState }) => (
          <SelectControl
            label={label}
            placeholder="Select an admin"
            value={field.value}
            onValueChange={field.onChange}
            onBlur={field.onBlur}
            ref={field.ref}
            {...(fieldState.error ? { error: fieldState.error.message } : {})}
            options={admins.map((admin) => ({ value: admin.partyId, label: admin.label }))}
          />
        )}
      />
    );
  }

  const conflict = errorCode(submit.error) === 'CONFLICT';

  /**
   * Sends the proposal.
   *
   * Both steps run behind `handleSubmit`, so the rules decide again on the
   * values as they stand. A draft that no longer passes them never reaches the
   * venue, and the operator is put back in the form with the errors on the
   * fields.
   */
  const startReview = handleSubmit((draft) => setReviewed(draft));
  const submitProposal = handleSubmit(
    async (draft) => {
      const created = await submit.perform(draft);
      if (created) onProposed(created);
    },
    () => setReviewed(null),
  );

  return (
    <Card>
      <CardHeader
        title="New proposal"
        actions={
          <Button type="button" size="sm" variant="ghost" onClick={onClose} disabled={submit.pending}>
            Cancel
          </Button>
        }
      />
      <form className="flex flex-col gap-4 p-5" onSubmit={startReview}>
        {options.error ? (
          <Banner
            variant="warning"
            title="Could not load the instrument admins"
            size="compact"
            dismissible={false}
          >
            {options.error.message}{' '}
            <TextLink onClick={options.reload}>Try again</TextLink>
          </Banner>
        ) : options.loading && !options.data ? (
          <SkeletonRows rows={2} label="Loading pool settings" />
        ) : null}

        {/*
          A reviewed draft is frozen where the browser freezes it, not through
          the form library: React Hook Form drops a disabled field from the
          values it hands `handleSubmit`, so routing the freeze through the
          kit's `readOnly` would have the submission receive an empty draft.
          `contents` keeps the grids below laying themselves out.

          Only the data controls are inside a fieldset. The advanced panel's
          own trigger stays outside one, so the operator can still open it and
          read what they are about to send.
        */}
        <fieldset disabled={reviewing} className="contents">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {adminField('baseAdmin', 'Base admin')}
            {text('baseId', 'Base instrument', 'The admin’s own id, such as USDC.')}
            {adminField('quoteAdmin', 'Quote admin')}
            {text('quoteId', 'Quote instrument')}
          </div>

          {text('name', 'Pool name')}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {text('feeBps', 'Fee, bps')}
            {text('lpTokenSupply', 'LP supply')}
            {text('baseReserve', 'Base reserve')}
            {text('quoteReserve', 'Quote reserve')}
          </div>
        </fieldset>

        <Disclosure summary="Advanced">
          <fieldset disabled={reviewing} className="contents">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {text('baseAccountId', 'Base account')}
              {text('quoteAccountId', 'Quote account')}
              {text('lpTokenId', 'LP token')}
            </div>
          </fieldset>
          {options.data ? (
            <DataList
              items={[
                {
                  label: 'dvo',
                  value: <Mono>{options.data.dvo}</Mono>,
                },
                {
                  label: 'Factory',
                  value: <Mono>{options.data.factoryId}</Mono>,
                },
              ]}
            />
          ) : null}
        </Disclosure>

        {submit.error ? (
          <Banner
            variant={conflict ? 'warning' : 'error'}
            title={conflict ? 'Already taken' : undefined}
            size="compact"
            dismissible={false}
          >
            {submit.error.message}
          </Banner>
        ) : null}

        {reviewed ? (
          <Card padded>
            <DataList
              items={[
                { label: 'Pair', value: `${reviewed.baseId} / ${reviewed.quoteId}` },
                { label: 'Name', value: reviewed.name },
                { label: 'Fee', value: `${reviewed.feeBps} bps` },
                { label: 'Reserves', value: `${reviewed.baseReserve} / ${reviewed.quoteReserve}` },
                { label: 'LP supply', value: reviewed.lpTokenSupply },
                {
                  label: 'LP token',
                  value: <Mono>{reviewed.lpTokenId}</Mono>,
                },
              ]}
            />
            <div className="mt-3 flex items-center gap-3">
              <LoadingButton
                type="button"
                loading={submit.pending}
                disabled={submit.pending}
                onClick={submitProposal}
              >
                Submit proposal
              </LoadingButton>
              <Button
                type="button"
                variant="ghost"
                disabled={submit.pending}
                onClick={() => setReviewed(null)}
              >
                Edit
              </Button>
            </div>
          </Card>
        ) : (
          <div className="flex items-center gap-3">
            <Button type="submit">Review</Button>
          </div>
        )}
      </form>
    </Card>
  );
}
