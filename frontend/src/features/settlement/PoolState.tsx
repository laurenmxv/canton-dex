import type { PoolDetail, Settlement, SettlementMonitoring } from '../../lib/api/types';
import { formatDecimal, formatExact } from '../../lib/decimal';
import {
  formatAge,
  formatFeeBps,
  poolHealthLabels,
  poolHealthTones,
  shortContract,
} from '../../lib/labels';
import { Badge, Callout } from '../../ui/Badge';
import { Card, CardHeader, DataList } from '../../ui/Card';
import { EmptyState } from '../../ui/States';
import { ReserveChart } from './ReserveChart';
import {
  invariantMatchesReserves,
  observationAgeSeconds,
  reserveDelta,
  STALE_OBSERVATION_SECONDS,
} from './reserves';

/**
 * What the venue last observed about this pool.
 *
 * Every line is a fact it reported: its own health verdict, the reserves at a
 * named ledger state, and when it looked. There is no score and no rating.
 * When an observation is old, it says so rather than reading as current.
 */
export function PoolState({
  pool,
  monitoring,
  lastConfirmed,
  now,
}: {
  pool: PoolDetail | undefined;
  monitoring: SettlementMonitoring | undefined;
  /** The most recent batch the ledger confirmed, which is where deltas come from. */
  lastConfirmed: Settlement | undefined;
  now: number;
}) {
  const snapshot = monitoring?.pool;
  const baseLabel = pool?.settings.baseInstrumentId.id ?? 'base';
  const quoteLabel = pool?.settings.quoteInstrumentId.id ?? 'quote';

  // The venue takes an observation to answer at all, so there is none only
  // while this screen is still waiting for its first answer.
  if (!snapshot) {
    return (
      <Card>
        <CardHeader title="Pool state" />
        <EmptyState title="No observation yet" />
      </Card>
    );
  }

  const age = observationAgeSeconds(snapshot.observedAt, now);
  const stale = age === null || age > STALE_OBSERVATION_SECONDS;
  const invariantHolds = invariantMatchesReserves(snapshot.reserves);
  const delta = reserveDelta(lastConfirmed?.before ?? null, lastConfirmed?.after ?? null);

  return (
    <Card>
      <CardHeader
        title="Pool state"
        description={`Ledger offset ${snapshot.ledgerOffset}`}
        actions={
          <Badge tone={poolHealthTones[snapshot.health]} dot={snapshot.health !== 'READY'}>
            {poolHealthLabels[snapshot.health]}
          </Badge>
        }
      />
      <div className="card-pad stack-sm">
        {snapshot.reason ? <Callout tone="warning">{snapshot.reason}</Callout> : null}

        {stale ? (
          <Callout tone="warning">
            {age === null
              ? 'Timestamp unavailable'
              : `Stale data · ${formatAge(snapshot.observedAt, now)}`}
          </Callout>
        ) : null}

        <DataList
          items={[
            {
              label: `${baseLabel} reserve`,
              value: <span className="tabular">{formatExact(snapshot.reserves.baseReserve)}</span>,
            },
            {
              label: `${quoteLabel} reserve`,
              value: (
                <span className="tabular">{formatExact(snapshot.reserves.quoteReserve)}</span>
              ),
            },
            {
              label: 'Spot price',
              value: (
                <span className="tabular">
                  {formatExact(snapshot.reserves.spotPrice)} {quoteLabel} per {baseLabel}
                </span>
              ),
            },
            { label: 'Fee', value: formatFeeBps(snapshot.feeBps) },
            {
              label: 'Invariant',
              value: (
                <span className="tabular">
                  {formatDecimal(snapshot.reserves.invariant, { maxFractionDigits: 2 })}
                  {invariantHolds === null
                    ? ' · not checked'
                    : invariantHolds
                      ? ' · matches the reserves'
                      : ' · does not match the reserves'}
                </span>
              ),
            },
            {
              label: 'Observed',
              value: `${formatAge(snapshot.observedAt, now)} ago`,
            },
            {
              label: 'Pool state',
              value: <span className="mono">{shortContract(snapshot.reserves.stateId)}</span>,
            },
          ]}
        />

        {delta && lastConfirmed?.before && lastConfirmed.after ? (
          <>
            <DataList
              items={[
                {
                  label: `${baseLabel} change, last confirmed batch`,
                  value: <span className="tabular">{signed(delta.base)}</span>,
                },
                {
                  label: `${quoteLabel} change, last confirmed batch`,
                  value: <span className="tabular">{signed(delta.quote)}</span>,
                },
              ]}
            />
            <ReserveChart
              before={lastConfirmed.before}
              after={lastConfirmed.after}
              baseLabel={baseLabel}
              quoteLabel={quoteLabel}
            />
          </>
        ) : null}
      </div>
    </Card>
  );
}

/** Keeps the sign a delta carries, because which way it moved is the point. */
function signed(value: string): string {
  const shown = formatExact(value);
  return value.startsWith('-') ? shown : `+${shown}`;
}
