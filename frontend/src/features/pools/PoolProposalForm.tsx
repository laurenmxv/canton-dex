import { Banner, Button, LoadingButton, TextField } from '@openzeppelin/ui-components';
import { useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useDexClient } from '../../app/runtime';
import { useAction, useAsync } from '../../app/useAsync';
import type { PoolProposalRecord, RegisteredInstrument } from '../../lib/api/types';
import { errorCode } from '../../lib/api/types';
import { Mono } from '../../ui/Mono';
import { TextLink } from '../../ui/Link';
import { Card, CardHeader, DataList } from '../../ui/Card';
import { Disclosure } from '../../ui/Disclosure';
import { SelectControl } from '../../ui/Field';
import { SkeletonRows } from '../../ui/States';
import {
  emptyDraft,
  instrumentChoices,
  instrumentReading,
  proposalResolver,
  proposedPool,
  registeredInstrument,
  suggestedName,
  toProposal,
  type DraftField,
  type ProposalDraft,
  type ProposedPool,
} from './poolForm';

/** One shared empty array, so the memos below hold while the venue has not answered. */
const NO_INSTRUMENTS: readonly RegisteredInstrument[] = [];

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
   * The pair the operator last put through the venue's rules, with the draft it
   * came from, or null while they are still editing. Holding the values rather
   * than a flag is what makes the summary and the submission provably the same.
   */
  const [reviewed, setReviewed] = useState<ProposedPool | null>(null);
  /** True once the operator wrote the name themselves, which a suggestion must not overwrite. */
  const [nameWritten, setNameWritten] = useState(false);

  const instruments = options.data?.instruments ?? NO_INSTRUMENTS;
  const choices = useMemo(() => instrumentChoices(instruments), [instruments]);
  // The rules run against the catalogue as the venue last answered it. That
  // answer is read once, so the venue refuses the pair again on its own side.
  const resolver = useMemo(() => proposalResolver(instruments), [instruments]);
  const form = useForm<ProposalDraft>({
    defaultValues: emptyDraft(),
    resolver,
    mode: 'onTouched',
  });
  const { control, getValues, setValue, handleSubmit } = form;

  const submit = useAction((proposed: ProposedPool) =>
    client.admin.createPoolProposal(toProposal(proposed)),
  );
  const reviewing = reviewed !== null;
  const nothingToChoose = instruments.length === 0;
  const empty = options.data !== undefined && nothingToChoose;

  /**
   * A suggestion only fills a name the operator has not written in.
   *
   * `onUserEdit` fires on a keystroke and never on `setValue`, so a name this
   * writes stays open to the next suggestion, and one the operator typed does
   * not.
   */
  function suggest() {
    const suggested = suggestedName(getValues(), instruments);
    if (!nameWritten && suggested) setValue('name', suggested, { shouldValidate: false });
  }

  function text(name: DraftField, label: string) {
    return (
      <TextField
        control={control}
        id={`proposal-${name}`}
        name={name}
        label={label}
        onUserEdit={() => {
          submit.clearError();
          if (name === 'name') setNameWritten(true);
        }}
      />
    );
  }

  /**
   * One side of the pair, out of what the venue registers.
   *
   * The value a row carries is the whole instrument, its administrator and that
   * administrator's own id, so the operator never names a party by hand and
   * never writes an instrument the venue has not registered. The hint repeats
   * both parts, because the row's own text is only as long as it needs to be.
   *
   * The kit's own `SelectField` gives no way to hand React Hook Form the blur
   * and the ref it needs to mark the field touched and to focus it as a first
   * error, so this composes the same listbox parts around a controller.
   */
  function instrumentField(name: 'base' | 'quote', label: string) {
    return (
      <Controller
        control={control}
        name={name}
        render={({ field, fieldState }) => {
          const chosen = registeredInstrument(instruments, field.value);
          return (
            <SelectControl
              label={label}
              placeholder={empty ? 'Nothing registered' : 'Select an instrument'}
              disabled={nothingToChoose}
              value={field.value}
              onValueChange={(value) => {
                submit.clearError();
                field.onChange(value);
                queueMicrotask(suggest);
              }}
              onBlur={field.onBlur}
              ref={field.ref}
              {...(chosen
                ? {
                    hint: (
                      <>
                        <Mono>{chosen.id}</Mono>, {chosen.decimals} decimals
                        <br />
                        Admin <Mono>{chosen.admin}</Mono>
                      </>
                    ),
                  }
                : {})}
              {...(fieldState.error ? { error: fieldState.error.message } : {})}
              options={choices}
            />
          );
        }}
      />
    );
  }

  const conflict = errorCode(submit.error) === 'CONFLICT';

  /**
   * Sends the proposal.
   *
   * Both steps run behind `handleSubmit`, so the rules decide again on the
   * values as they stand, against the catalogue the venue last answered with. A
   * draft that no longer passes them never reaches the venue, and the operator
   * is put back in the form with the errors on the fields.
   */
  const startReview = handleSubmit((draft) => setReviewed(proposedPool(draft, instruments)));

  /** The pair as the operator picked it, named the way the rows named it. */
  function summary({ draft, base, quote }: ProposedPool) {
    return [
      { label: 'Pair', value: `${instrumentReading(base)} / ${instrumentReading(quote)}` },
      { label: 'Base admin', value: <Mono>{base.admin}</Mono> },
      { label: 'Quote admin', value: <Mono>{quote.admin}</Mono> },
      { label: 'Name', value: draft.name },
      { label: 'Fee', value: `${draft.feeBps} bps` },
    ];
  }

  const submitProposal = handleSubmit(
    async (draft) => {
      // This resolves the pair against the catalogue the venue last answered
      // with, which is what the review showed. The venue checks the current
      // registration itself when the proposal arrives.
      const proposed = proposedPool(draft, instruments);
      setReviewed(proposed);
      if (!proposed) return;
      const created = await submit.perform(proposed);
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
            title="Could not load the registered instruments"
            size="compact"
            dismissible={false}
          >
            {options.error.message}{' '}
            <TextLink onClick={options.reload}>Try again</TextLink>
          </Banner>
        ) : options.loading && !options.data ? (
          <SkeletonRows rows={2} label="Loading pool settings" />
        ) : empty ? (
          <Banner
            variant="warning"
            title="No registered instruments"
            size="compact"
            dismissible={false}
          >
            The venue registers no instrument yet, so a pool has nothing to hold. Register a token
            first.
          </Banner>
        ) : null}

        {/*
          A reviewed draft is frozen where the browser freezes it, not through
          the form library: React Hook Form drops a disabled field from the
          values it hands `handleSubmit`, so routing the freeze through the
          kit's `readOnly` would have the submission receive an empty draft.
          `contents` keeps the grids below laying themselves out.

          The dvo configures the accounts, the LP token and the initial ratio
          when they accept, so the form asks for none of them.
        */}
        <fieldset disabled={reviewing} className="contents">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {instrumentField('base', 'Base instrument')}
            {instrumentField('quote', 'Quote instrument')}
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {text('name', 'Pool name')}
            {text('feeBps', 'Fee, bps')}
          </div>
        </fieldset>

        {options.data ? (
          <Disclosure summary="dvo and factory">
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
          </Disclosure>
        ) : null}

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
            <DataList items={summary(reviewed)} />
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
