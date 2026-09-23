import { Banner, CardContent } from '@openzeppelin/ui-components';
import { cn } from '@openzeppelin/ui-utils';
import type { ReactNode } from 'react';
import type { PoolDetail, SettlementMonitoring } from '../../lib/api/types';
import { formatExact } from '../../lib/decimal';
import { formatAge, formatFeeBps, poolHealthLabels, poolHealthTones } from '../../lib/labels';
import { StatusBadge } from '../../ui/Badge';
import { Card } from '../../ui/Card';
import {
  invariantMatchesReserves,
  observationAgeSeconds,
  STALE_OBSERVATION_SECONDS,
} from './reserves';

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-muted-foreground text-[0.6875rem] font-medium tracking-[0.04em] uppercase">{label}</dt>
      <dd className="text-sm font-medium tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * What the venue last observed about this pool, on one line: its reserves, its
 * supply, its health and how old the observation is. An old one says so.
 */
export function PoolState({
  pool,
  monitoring,
  now,
}: {
  pool: PoolDetail;
  monitoring: SettlementMonitoring | undefined;
  now: number;
}) {
  const snapshot = monitoring?.pool;
  const baseLabel = pool.settings.baseInstrumentId.id;
  const quoteLabel = pool.settings.quoteInstrumentId.id;

  // The venue takes an observation to answer at all, so there is none only
  // while this screen is still waiting for its first answer.
  if (!snapshot) {
    return (
      <Card>
        <div className="flex items-center gap-3 px-5 py-4">
          <h2 className="text-[0.9375rem] font-semibold">Pool state</h2>
          <span className="text-muted-foreground text-xs">No observation yet</span>
        </div>
      </Card>
    );
  }

  const age = observationAgeSeconds(snapshot.observedAt, now);
  const stale = age === null || age > STALE_OBSERVATION_SECONDS;
  const invariantHolds = invariantMatchesReserves(snapshot.reserves);
  const ratio = (value: string) => `${formatExact(value)} ${quoteLabel} per ${baseLabel}`;
  // An empty pool has no ratio to divide, so the venue sends no price, and the
  // configured ratio is what prices its first deposit.
  const empty = snapshot.reserves.spotPrice === null;
  // A reason with no request behind it is a pool setting that stops dispatch.
  const dispatchReason = monitoring?.blockedRequest === null ? monitoring.blockedReason : null;

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3 px-5 py-4">
        <div className="flex items-center gap-2.5">
          <h2 className="text-[0.9375rem] font-semibold">Pool state</h2>
          <StatusBadge
            tone={poolHealthTones[snapshot.health]}
            dot={snapshot.health !== 'READY'}
            label={poolHealthLabels[snapshot.health]}
          />
        </div>
        <dl className="flex flex-wrap gap-x-7 gap-y-2">
          <Stat label={`${baseLabel} reserve`} value={formatExact(snapshot.reserves.baseReserve)} />
          <Stat label={`${quoteLabel} reserve`} value={formatExact(snapshot.reserves.quoteReserve)} />
          <Stat label="LP supply" value={formatExact(snapshot.lpTokenSupply)} />
          <Stat
            label="Spot price"
            value={empty ? 'None until the first deposit' : ratio(snapshot.reserves.spotPrice!)}
          />
          {empty ? <Stat label="Initial ratio" value={ratio(snapshot.initialRatio)} /> : null}
          <Stat label="Fee" value={formatFeeBps(snapshot.feeBps)} />
        </dl>
        <span
          className={cn(
            'ml-auto text-xs tabular-nums',
            stale ? 'font-semibold text-[color:var(--warning)]' : 'text-muted-foreground',
          )}
        >
          {age === null
            ? 'Timestamp unavailable'
            : stale
              ? `Stale data · ${formatAge(snapshot.observedAt, now)}`
              : `Observed ${formatAge(snapshot.observedAt, now)} ago`}
          <span className="text-muted-foreground font-normal"> · offset {snapshot.ledgerOffset}</span>
        </span>
      </div>

      {snapshot.reason || invariantHolds === false || dispatchReason ? (
        <CardContent className="flex flex-col gap-2 px-5 pt-0 pb-4">
          {snapshot.reason ? (
            <Banner variant="warning" size="compact" dismissible={false}>
              {snapshot.reason}
            </Banner>
          ) : null}
          {invariantHolds === false ? (
            <Banner variant="warning" size="compact" dismissible={false}>
              The reported invariant does not match the reserves.
            </Banner>
          ) : null}
          {dispatchReason ? (
            <Banner variant="warning" title="This pool cannot dispatch a batch" size="compact" dismissible={false}>
              {dispatchReason}
            </Banner>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}
