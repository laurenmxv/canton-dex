import { CardContent, DataTable, type DataTableColumn } from '@openzeppelin/ui-components';
import { useId } from 'react';
import type { AsyncResult } from '../../app/useAsync';
import type { TokenBalance, TokenBalances } from '../../lib/api/types';
import { formatExact, isZeroAmount } from '../../lib/decimal';
import { Card, CardHeader } from '../../ui/Card';
import { Disclosure } from '../../ui/Disclosure';
import { AsyncSection, EmptyState } from '../../ui/States';
import { NUMERIC } from '../../ui/table';

/**
 * A balance at its instrument's own precision: a whole satoshi shown to six
 * places would read as nothing.
 */
const BALANCE_COLUMNS: DataTableColumn<TokenBalance>[] = [
  { id: 'token', header: 'Token', cell: (balance) => balance.symbol },
  {
    ...NUMERIC,
    id: 'available',
    header: 'Available',
    cell: (balance) => formatExact(balance.available, balance.decimals),
  },
  {
    ...NUMERIC,
    id: 'locked',
    header: 'Locked',
    cell: (balance) => formatExact(balance.locked, balance.decimals),
  },
];

function keyOf(balance: TokenBalance): string {
  return `${balance.instrument.admin}/${balance.instrument.id}`;
}

/**
 * What is held leads; instruments with nothing held, available or locked, such
 * as the LP of pools never joined, fold away under their own names.
 */
function BalanceList({ balances, titleId }: { balances: readonly TokenBalance[]; titleId: string }) {
  const held = balances.filter((balance) => !isZeroAmount(balance.total));
  const empty = balances.filter((balance) => isZeroAmount(balance.total));
  return (
    <>
      {held.length === 0 ? (
        <EmptyState title="No balances yet" />
      ) : (
        <DataTable
          aria-labelledby={titleId}
          columns={BALANCE_COLUMNS}
          rows={held}
          getRowKey={keyOf}
          className="border-0"
        />
      )}
      {empty.length > 0 ? (
        <CardContent className="px-5 pt-2 pb-4">
          <Disclosure
            summary={`${empty.length} instrument${empty.length === 1 ? '' : 's'} with no balance`}
          >
            <ul className="flex flex-col gap-1">
              {empty.map((balance) => (
                <li key={keyOf(balance)}>{balance.symbol}</li>
              ))}
            </ul>
          </Disclosure>
        </CardContent>
      ) : null}
    </>
  );
}

export function Balances({ balances }: { balances: AsyncResult<TokenBalances> }) {
  const titleId = useId();
  return (
    <Card>
      <CardHeader title="Balances" titleId={titleId} />
      <AsyncSection result={balances} label="Loading your balances" rows={3}>
        {(read) => <BalanceList balances={read.balances} titleId={titleId} />}
      </AsyncSection>
    </Card>
  );
}
