import { useState } from 'react';
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
import { Badge, Callout } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card, CardHeader, DataList } from '../../ui/Card';
import { TextField } from '../../ui/Field';
import { SimulatedLedgerNotice } from '../../ui/SimulatedLedger';
import { ErrorState, Loading, RefreshFailure } from '../../ui/States';
import { Steps, type StepItem } from '../../ui/Steps';
import { AttestationReceipt } from '../dashboard/AttestationReceipt';
import { DocumentList } from './DocumentList';
import { NoticeBoard } from '../../ui/NoticeBoard';
import { useOnboardingNotices } from './notices';
import { documentTemplates, formatSize, toDocument } from './documents';
import { PartyRegistration } from './PartyRegistration';
import { isSettling, isWorking } from './progress';

export function TraderOnboarding({ onGoToSwap }: { onGoToSwap: () => void }) {
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
    <div className="stack-lg fade-in">
      <header className="page-head">
        <h1 className="page-title">Onboarding</h1>
      </header>

      {onboarding.error && onboarding.data !== undefined ? (
        <RefreshFailure error={onboarding.error} onRetry={onboarding.reload} />
      ) : null}

      {onboarding.data ? (
        <OnboardingProgress
          onboarding={onboarding.data}
          pools={pools.data ?? []}
          onChanged={onboarding.reload}
          onGoToSwap={onGoToSwap}
        />
      ) : (
        <ApplicationForm onSubmitted={onboarding.reload} />
      )}
    </div>
  );
}

function ApplicationForm({ onSubmitted }: { onSubmitted: () => void }) {
  const client = useDexClient();
  const [legalName, setLegalName] = useState('');
  const [countryCode, setCountryCode] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);

  const errors = {
    legalName: legalName.trim() ? undefined : 'Legal name is required',
    countryCode: COUNTRY_CODE_PATTERN.test(countryCode)
      ? undefined
      : 'Use a two-letter ISO country code, such as PT',
    documents:
      chosen.length >= applicationLimits.documentsMin &&
      chosen.length <= applicationLimits.documentsMax
        ? undefined
        : `Attach between ${applicationLimits.documentsMin} and ${applicationLimits.documentsMax} documents`,
  };
  const valid = Object.values(errors).every((error) => error === undefined);

  const submit = useAction(() =>
    client.onboarding.submitApplication({
      legalName: legalName.trim(),
      countryCode,
      documents: documentTemplates
        .filter((template) => chosen.includes(template.key))
        .map(toDocument),
    }),
  );

  const toggle = (key: string) =>
    setChosen((current) =>
      current.includes(key)
        ? current.filter((candidate) => candidate !== key)
        : [...current, key],
    );

  async function handleSubmit() {
    setTouched(true);
    if (!valid) return;
    if (await submit.perform()) onSubmitted();
  }

  return (
    <Card>
      <CardHeader title="Submit your application" />
      <div className="card-pad stack">
        <TextField
          label="Legal name"
          value={legalName}
          maxLength={applicationLimits.legalNameMaxLength}
          placeholder="Registered name of your firm"
          error={touched ? errors.legalName : undefined}
          onChange={(event) => setLegalName(event.target.value)}
        />
        <TextField
          label="Country of incorporation"
          value={countryCode}
          maxLength={2}
          placeholder="PT"
          error={touched ? errors.countryCode : undefined}
          onChange={(event) => setCountryCode(event.target.value.toUpperCase())}
        />
        <fieldset className="stack-sm">
          <legend className="field-label" style={{ marginBottom: '0.5rem' }}>
            Supporting documents
          </legend>
          <Callout tone="demo">Test documents: no files are uploaded</Callout>
          {documentTemplates.map((template) => (
            <label key={template.key} className="row text-sm">
              <input
                type="checkbox"
                checked={chosen.includes(template.key)}
                onChange={() => toggle(template.key)}
              />
              <span>{template.fileName}</span>
              <span className="muted">
                {documentCategoryLabels[template.category]} · {formatSize(template.sizeBytes)}
              </span>
            </label>
          ))}
          {touched && errors.documents ? (
            <p className="field-error">{errors.documents}</p>
          ) : null}
        </fieldset>
        {submit.error ? <Callout tone="danger">{submit.error.message}</Callout> : null}
        <div className="row">
          <Button onClick={handleSubmit} loading={submit.pending}>
            Submit application
          </Button>
          <span className="muted text-xs">
            {chosen.length} document{chosen.length === 1 ? '' : 's'} attached
          </span>
        </div>
      </div>
    </Card>
  );
}

function OnboardingProgress({
  onboarding,
  pools,
  onChanged,
  onGoToSwap,
}: {
  onboarding: Onboarding;
  pools: PoolSummary[];
  onChanged: () => void;
  onGoToSwap: () => void;
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
        <div className="stack-sm">
          <Badge tone={rejected ? 'danger' : 'success'}>
            {rejected ? 'Rejected' : 'Approved'}
          </Badge>
          <p className="muted text-xs">
            {rejected ? 'No pool access granted' : `Approved for ${approvedNames.join(', ')}`}
          </p>
        </div>
      ) : (
        <div className="stack-sm">
          <p className="muted text-xs">Waiting for the venue operator</p>
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
          <div className="stack-sm">
            {simulated ? <SimulatedLedgerNotice /> : null}
            <ul className="stack-sm" aria-live="polite">
              {onboarding.ledgerSteps.map((step) => (
                <li key={step.key} className="row-between">
                  <span>{ledgerStepLabel(step.key, (poolId) => poolNameOf(pools, poolId))}</span>
                  <Badge tone={ledgerStepTones[step.status]} dot={step.status === 'SUBMITTING'}>
                    {step.status}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="stack">
      <NoticeBoard notices={updates.notices} onDismiss={updates.dismiss} />

      <Card>
        <CardHeader
          title="Your onboarding"
          description={`Reference ${onboarding.id}`}
          actions={
            <Badge
              tone={onboardingStatusTones[onboarding.status]}
              dot={isWorking(onboarding)}
            >
              {onboardingStatusLabels[onboarding.status]}
            </Badge>
          }
        />
        <div className="card-pad">
          <Steps steps={steps} />
        </div>
      </Card>

      {onboarding.status === 'COMPLETED' ? (
        <Card padded>
          <div className="row-between">
            <div>
              <h2 className="card-title">Onboarding complete</h2>
              <p className="card-desc">{approvedNames.join(', ')}</p>
            </div>
            <Button onClick={onGoToSwap}>Request a swap</Button>
          </div>
        </Card>
      ) : null}

      {/* The receipt belongs where the reader is waiting, not one screen away. */}
      <AttestationReceipt onboarding={onboarding} pools={pools} simulated={simulated} />
    </div>
  );
}
