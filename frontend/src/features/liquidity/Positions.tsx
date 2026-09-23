import { DataTable, LoadingButton as Button } from '@openzeppelin/ui-components';
import { useId } from 'react';
import type { AsyncResult } from '../../app/useAsync';
import type { LpPosition, LpPositions, TokenBalance } from '../../lib/api/types';
import { formatExact, isZero, parseDecimal } from '../../lib/decimal';
import { Card, CardHeader } from '../../ui/Card';
import { NUMERIC } from '../../ui/table';
import { AsyncSection, EmptyState } from '../../ui/States';
import { instrumentLabel } from '../swap/terms';
import { sharePercent } from './terms';

function redeemable(position: LpPosition): boolean {
  const available = parseDecimal(position.availableLp);
  return available !== null && !isZero(available);
}

/**
 * Every LP position, whatever the trader's current pool access, as the venue
 * values it. Only a pool the trader's access opens offers a withdrawal.
 */
export function Positions({
  positions,
  balances,
  openPoolIds,
  disabled,
  onWithdraw,
}: {
  positions: AsyncResult<LpPositions>;
  balances: readonly TokenBalance[];
  openPoolIds: readonly string[];
  disabled: boolean;
  onWithdraw: (position: LpPosition) => void;
}) {
  const title = useId();
  return (
    <Card>
      <CardHeader title="Your positions" titleId={title} />
      <AsyncSection result={positions} label="Loading your positions" rows={2}>
        {(page) =>
          page.items.length === 0 ? (
            <EmptyState title="No positions yet" />
          ) : (
            <DataTable
              aria-labelledby={title}
              columns={[
                { id: 'pool', header: 'Pool', cell: (position) => position.poolName },
                {
                  ...NUMERIC,
                  id: 'lp',
                  header: 'LP available',
                  cell: (position) => formatExact(position.availableLp),
                },
                {
                  ...NUMERIC,
                  id: 'allocated',
                  header: 'LP in withdrawals',
                  cell: (position) => formatExact(position.allocatedLp),
                },
                {
                  ...NUMERIC,
                  id: 'share',
                  header: 'Pool share',
                  cell: (position) => sharePercent(position.share),
                },
                {
                  ...NUMERIC,
                  id: 'value',
                  header: 'Value',
                  cell: (position) =>
                    `${formatExact(position.baseValue)} ${instrumentLabel(balances, position.baseInstrument)} + ${formatExact(position.quoteValue)} ${instrumentLabel(balances, position.quoteInstrument)}`,
                },
                {
                  id: 'action',
                  header: 'Action',
                  cell: (position) => (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={
                        disabled || !redeemable(position) || !openPoolIds.includes(position.poolId)
                      }
                      onClick={() => onWithdraw(position)}
                    >
                      Withdraw
                    </Button>
                  ),
                },
              ]}
              rows={page.items}
              getRowKey={(position) => position.poolId}
              className="border-0"
            />
          )
        }
      </AsyncSection>
    </Card>
  );
}
