import {
  Banner,
  CardContent,
  Checkbox,
  Label,
  LoadingButton as Button,
  TextField,
} from '@openzeppelin/ui-components';
import { useForm, type FieldErrors, type Resolver } from 'react-hook-form';
import { useDemoApi, useDexClient, useWallet } from '../../app/runtime';
import { useAction, useAsync } from '../../app/useAsync';
import type { Onboarding, PoolSummary } from '../../lib/api/types';
import { applicationLimits, COUNTRY_CODE_PATTERN } from '../../lib/api/types';
import {
  documentCategoryLabels,
  ledgerStepLabel,
  ledgerStepTones,
  onboardingStatusLabels,
  onboardingStatusTones,
  poolNameOf,
} from '../../lib/labels';
import { StatusBadge } from '../../ui/Badge';
import { Card, CardHeader, DataList } from '../../ui/Card';
import { SimulatedLedgerNotice } from '../../ui/SimulatedLedger';
import { ErrorState, Loading, RefreshFailure } from '../../ui/States';
import { Steps, type StepItem } from '../../ui/Steps';
import { AttestationReceipt } from '../dashboard/AttestationReceipt';
import { DocumentList } from './DocumentList';
import { NoticeBoard } from '../../ui/NoticeBoard';
import { Note } from '../../ui/Note';
import { PageHeader } from '../../ui/PageHeader';
import { useOnboardingNotices } from './notices';
import { documentTemplates, formatSize, toDocument } from './documents';
import { PartyRegistration } from './PartyRegistration';
import { isSettling, isWorking } from './progress';

export function TraderOnboarding() {
  const client = useDexClient();
  const onboarding = useAsync((signal) => client.onboarding.mine({ signal }), [client], {
    pollWhile: isSettling,
  });
  const pools = useAsync((signal) => client.pools.list({ signal }), [client]);

  // Only the first load takes the screen away; a reload keeps it, so the
  // notices it has already seen are not forgotten.
  if (onboarding.loading && !onboarding.data) return <Loading label="Loading your onboarding" />;
  if (onboarding.error && !onboarding.data) {
    return <ErrorState error={onboarding.error} onRetry={onboarding.reload} />;
  }

  return (
    <div className="flex flex-col gap-6 fade-in">
      <PageHeader
        title="Onboarding"
        description="Apply, wait for the review, register your party, and let the ledger confirm."
      />

      {onboarding.error && onboarding.data !== undefined ? (
        <RefreshFailure error={onboarding.error} onRetry={onboarding.reload} />
      ) : null}

      {onboarding.data ? (
        <OnboardingProgress
          onboarding={onboarding.data}
          pools={pools.data ?? []}
          onChanged={onboarding.reload}
        />
      ) : (
        <ApplicationForm onSubmitted={onboarding.reload} />
      )}
    </div>
  );
}

interface Application {
  legalName: string;
  countryCode: string;
  chosen: string[];
}

/** The venue's own bounds, checked here so an application is not sent to be refused. */
const applicationResolver: Resolver<Application> = (values) => {
  const found: FieldErrors<Application> = {};
  const legalName = values.legalName.trim();
  if (!legalName) {
    found.legalName = { type: 'venue', message: 'Legal name is required' };
  } else if (legalName.length > applicationLimits.legalNameMaxLength) {
    // The backend carries the same bound, so a longer name is refused there.
    found.legalName = {
      type: 'venue',
      message: `Legal name must be at most ${applicationLimits.legalNameMaxLength} characters`,
    };
  }
  if (!COUNTRY_CODE_PATTERN.test(values.countryCode)) {
    found.countryCode = {
      type: 'venue',
      message: 'Use a two-letter ISO country code, such as PT',
    };
  }
  const { documentsMin, documentsMax } = applicationLimits;
  if (values.chosen.length < documentsMin || values.chosen.length > documentsMax) {
    found.chosen = {
      type: 'venue',
      message: `Attach between ${documentsMin} and ${documentsMax} documents`,
    };
  }
  return Object.keys(found).length === 0
    ? { values, errors: {} }
    : { values: {}, errors: found };
};

function ApplicationForm({ onSubmitted }: { onSubmitted: () => void }) {
  const client = useDexClient();
  const {
    control,
    getValues,
    setValue,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<Application>({
    defaultValues: { legalName: '', countryCode: '', chosen: [] },
    resolver: applicationResolver,
    mode: 'onTouched',
  });

  const chosen = watch('chosen');

  const submit = useAction(() => {
    const values = getValues();
    return client.onboarding.submitApplication({
      legalName: values.legalName.trim(),
      countryCode: values.countryCode,
      documents: documentTemplates
        .filter((template) => values.chosen.includes(template.key))
        .map(toDocument),
    });
  });

  const toggle = (key: string) =>
    setValue(
      'chosen',
      chosen.includes(key) ? chosen.filter((candidate) => candidate !== key) : [...chosen, key],
      { shouldValidate: true },
    );

  async function send() {
    if (await submit.perform()) onSubmitted();
  }

  return (
    <Card>
      <CardHeader title="Submit your application" />
      <form className="flex flex-col gap-4 p-5" onSubmit={handleSubmit(send)}>
        <TextField
          control={control}
          id="application-legal-name"
          name="legalName"
          label="Legal name"
          placeholder="Registered name of your firm"
        />
        <TextField
          control={control}
          id="application-country"
          name="countryCode"
          label="Country of incorporation"
          placeholder="PT"
          onUserEdit={(value) =>
            setValue('countryCode', value.toUpperCase(), { shouldValidate: false })
          }
        />
        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs font-medium" style={{ marginBottom: '0.5rem' }}>
            Supporting documents
          </legend>
          <Note tone="demo">Test documents: no files are uploaded</Note>
          {documentTemplates.map((template) => (
            <Label key={template.key} className="hover:bg-surface flex items-center gap-2.5 rounded-md border px-3 py-2.5 text-sm">
              <Checkbox
                checked={chosen.includes(template.key)}
                onCheckedChange={() => toggle(template.key)}
              />
              <span className="min-w-0 flex-1 truncate">{template.fileName}</span>
              <span className="text-muted-foreground text-xs">
                {documentCategoryLabels[template.category]} · {formatSize(template.sizeBytes)}
              </span>
            </Label>
          ))}
          {errors.chosen ? (
            <p className="text-destructive text-[0.75rem]">{errors.chosen.message}</p>
          ) : null}
        </fieldset>
        {submit.error ? <Banner variant="error" size="compact" dismissible={false}>{submit.error.message}</Banner> : null}
        <div className="flex items-center gap-3">
          <Button type="submit" loading={submit.pending}>
            Submit application
          </Button>
          <span className="text-muted-foreground text-xs">
            {chosen.length} document{chosen.length === 1 ? '' : 's'} attached
          </span>
        </div>
      </form>
    </Card>
  );
}

function OnboardingProgress({
  onboarding,
  pools,
  onChanged,
}: {
  onboarding: Onboarding;
  pools: PoolSummary[];
  onChanged: () => void;
}) {
  // Only the demo produces its own identifiers; the venue's are real.
  const demo = useDemoApi();
  const simulated = demo !== null;
  const wallet = useWallet();
  const updates = useOnboardingNotices(onboarding);
  const party = onboarding.party;
  const review = onboarding.review;
  const rejected = review?.decision === 'REJECTED';
  const approvedNames = (review?.approvedPoolIds ?? []).map((poolId) =>
    poolNameOf(pools, poolId),
  );

  const steps: StepItem[] = [
    {
      title: 'Application submitted',
      state: 'done',
      body: (
        <DataList
          items={[
            { label: 'Legal name', value: onboarding.application.legalName },
            { label: 'Country', value: onboarding.application.countryCode },
            {
              label: 'Documents',
              value: <DocumentList application={onboarding.application} />,
            },
          ]}
        />
      ),
    },
    {
      title: 'Compliance review',
      state: review ? 'done' : 'current',
      body: review ? (
        <div className="flex flex-col gap-2">
          {/* A badge states one thing, so it hugs its own words rather than
              stretching across the step. */}
          <div className="flex items-center gap-3">
            <StatusBadge tone={rejected ? 'danger' : 'success'} label={rejected ? 'Rejected' : 'Approved'} />
          </div>
          <p className="text-muted-foreground text-xs">
            {rejected ? 'No pool access granted' : `Approved for ${approvedNames.join(', ')}`}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground text-xs">Waiting for the venue operator</p>
          <div>
            <Button size="sm" variant="secondary" onClick={onChanged}>
              Check for updates
            </Button>
          </div>
        </div>
      ),
    },
    {
      title: 'Party registration',
      state: party?.confirmed ? 'done' : review?.decision === 'APPROVED' ? 'current' : 'todo',
      body: (
        <PartyRegistration
          onboarding={onboarding}
          onChanged={onChanged}
          demo={demo ?? undefined}
          wallet={wallet ?? undefined}
        />
      ),
    },
    {
      title: 'Ledger confirmations',
      state:
        onboarding.status === 'COMPLETED'
          ? 'done'
          : onboarding.ledgerSteps.length > 0
            ? 'current'
            : 'todo',
      body:
        onboarding.ledgerSteps.length > 0 ? (
          <div className="flex flex-col gap-2">
            {simulated ? <SimulatedLedgerNotice /> : null}
            <ul className="flex flex-col gap-2" aria-live="polite">
              {onboarding.ledgerSteps.map((step) => (
                <li key={step.key} className="flex items-center justify-between gap-3">
                  <span>{ledgerStepLabel(step.key, (poolId) => poolNameOf(pools, poolId))}</span>
                  <StatusBadge tone={ledgerStepTones[step.status]} dot={step.status === 'SUBMITTING'} label={step.status} />
                </li>
              ))}
            </ul>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <NoticeBoard notices={updates.notices} onDismiss={updates.dismiss} />

      <Card>
        <CardHeader
          title="Your onboarding"
          description={`Reference ${onboarding.id}`}
          actions={
            <StatusBadge
              tone={onboardingStatusTones[onboarding.status]}
              dot={isWorking(onboarding)} label={onboardingStatusLabels[onboarding.status]} />
          }
        />
        <CardContent className="p-5">
          <Steps steps={steps} />
        </CardContent>
      </Card>

      {/* The receipt belongs where the reader is waiting, not one screen away. */}
      <AttestationReceipt onboarding={onboarding} pools={pools} simulated={simulated} />
    </div>
  );
}
