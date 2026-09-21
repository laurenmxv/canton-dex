import {
  Banner,
  CardContent,
} from '@openzeppelin/ui-components';
import type { PoolDetail, Settlement, SettlementMonitoring } from '../../lib/api/types';
import { formatDecimal, formatExact } from '../../lib/decimal';
import {
  formatAge,
  formatFeeBps,
  poolHealthLabels,
  poolHealthTones,
  shortContract,
} from '../../lib/labels';
import { Mono } from '../../ui/Mono';
import { StatusBadge } from '../../ui/Badge';
import { Card, CardHeader, DataList } from '../../ui/Card';
import { EmptyState } from '../../ui/States';
import { ReserveChart } from './ReserveChart';
import {
  invariantMatchesReserves,
  observationAgeSeconds,
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

  return (
    <Card>
      <CardHeader
        title="Pool state"
        description={`Ledger offset ${snapshot.ledgerOffset}`}
        actions={
          <StatusBadge tone={poolHealthTones[snapshot.health]} dot={snapshot.health !== 'READY'} label={poolHealthLabels[snapshot.health]} />
        }
      />
      <CardContent className="p-5 flex flex-col gap-2">
        {snapshot.reason ? <Banner variant="warning" size="compact" dismissible={false}>{snapshot.reason}</Banner> : null}

        {stale ? (
          <Banner variant="warning" size="compact" dismissible={false}>
            {age === null
              ? 'Timestamp unavailable'
              : `Stale data · ${formatAge(snapshot.observedAt, now)}`}
          </Banner>
        ) : null}

        <DataList
          items={[
            {
              label: `${baseLabel} reserve`,
              value: <span className="tabular-nums">{formatExact(snapshot.reserves.baseReserve)}</span>,
            },
            {
              label: `${quoteLabel} reserve`,
              value: (
                <span className="tabular-nums">{formatExact(snapshot.reserves.quoteReserve)}</span>
              ),
            },
            {
              label: 'Spot price',
              value: (
                <span className="tabular-nums">
                  {formatExact(snapshot.reserves.spotPrice)} {quoteLabel} per {baseLabel}
                </span>
              ),
            },
            { label: 'Fee', value: formatFeeBps(snapshot.feeBps) },
            {
              label: 'Invariant',
              value: (
                <span className="tabular-nums">
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
              value: <Mono>{shortContract(snapshot.reserves.stateId)}</Mono>,
            },
          ]}
        />

        {lastConfirmed && lastConfirmed.before && lastConfirmed.after ? (
          <ReserveChart
            settlement={lastConfirmed}
            before={lastConfirmed.before}
            after={lastConfirmed.after}
            baseLabel={baseLabel}
            quoteLabel={quoteLabel}
            currentStateId={snapshot.reserves.stateId}
            now={now}
          />
        ) : (
          // Saying nothing here would leave the figures above looking like a
          // comparison. There is nothing to compare them with yet.
          <Banner variant="info" title="No confirmed batch to compare with" size="compact" dismissible={false}>
            The reserves above are one observation, not a change. A chart of the move appears once
            the ledger confirms a batch for this pool.
          </Banner>
        )}
      </CardContent>
    </Card>
  );
}
