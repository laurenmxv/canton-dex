import {
  Banner,
  CardContent,
  DataTable,
  LoadingButton as Button,
} from '@openzeppelin/ui-components';
import { useEffect, useId, useRef, useState } from 'react';
import { useAction, useLive } from '../../app/useAsync';
import type {
  LiquidityPreparation,
  LiquidityRequest,
  SubmitSignatureInput,
  TokenBalance,
} from '../../lib/api/types';
import {
  formatDateTime,
  liquidityStatusLabels,
  liquidityStatusTones,
  shortContract,
} from '../../lib/labels';
import { StatusBadge } from '../../ui/Badge';
import { Card, CardHeader, DataList } from '../../ui/Card';
import { DetailDialog } from '../../ui/DetailDialog';
import { Mono, References } from '../../ui/Mono';
import { AsyncSection, EmptyState } from '../../ui/States';
import { NUMERIC } from '../../ui/table';
import { walletMessage, type WalletSigner } from '../wallet/signing';
import { lacksPoolAccess } from '../onboarding/progress';
import { effectUnit, recoveryLine, requestAmounts, settledItems } from './terms';
import type { RequestHistory } from './useRequestHistory';

type RecoveryPreparation = LiquidityPreparation<unknown>;

/**
 * One kind of liquidity request, newest first. A recovery is shown before it
 * is signed, so the trader reads what it returns and what it only releases.
 * Only a pool the trader's access opens offers a recovery.
 */
export function LiquidityHistory<R extends LiquidityRequest>({
  title,
  history,
  balances,
  signer,
  openPoolIds,
  prepareRecovery,
  submitRecovery,
  onRecovered,
}: {
  title: string;
  history: RequestHistory<R>;
  balances: readonly TokenBalance[];
  signer: WalletSigner;
  openPoolIds: readonly string[];
  prepareRecovery: (requestId: string) => Promise<RecoveryPreparation>;
  submitRecovery: (requestId: string, input: SubmitSignatureInput) => Promise<R>;
  onRecovered: () => void;
}) {
  const titleId = useId();
  const live = useLive();
  const currentPoolIds = useRef(openPoolIds);
  currentPoolIds.current = openPoolIds;
  const canRecover = (poolId: string) => live() && currentPoolIds.current.includes(poolId);
  const [preparing, setPreparing] = useState<string>();
  const [draft, setDraft] = useState<{ request: R; preparation: RecoveryPreparation }>();

  useEffect(() => {
    if (draft && !openPoolIds.includes(draft.request.terms.poolId)) setDraft(undefined);
  }, [draft, openPoolIds]);

  const prepare = useAction(async (request: R) => {
    if (!canRecover(request.terms.poolId)) return;
    recover.clearError();
    setPreparing(request.requestId);
    const preparation = await prepareRecovery(request.requestId);
    if (canRecover(request.terms.poolId)) setDraft({ request, preparation });
  });

  const recover = useAction(async ({ request, preparation }: NonNullable<typeof draft>) => {
    if (!canRecover(request.terms.poolId)) return;
    const effects = preparation.recoveryEffects;
    const lp = request.terms.lpInstrument;
    const signature = await signer.sign(preparation, {
      operation: 'Recover funds',
      tokenSymbol: [...new Set(effects.map((effect) => effectUnit(effect, balances, lp)))].join(', '),
      amount: effects.map((effect) => recoveryLine(effect, balances, lp)).join('; '),
      recipient: request.terms.poolName,
      sender: request.terms.trader,
    });
    if (!canRecover(request.terms.poolId)) return;
    return submitRecovery(request.requestId, { preparationId: preparation.preparationId, signature });
  });

  const error = prepare.error ?? recover.error;
  const busy = prepare.pending || recover.pending;

  return (
    <Card>
      <CardHeader title={title} titleId={titleId} />

      {history.recovering ? (
        <CardContent className="p-5">
          <Banner variant="warning" title="Sent, not confirmed yet" size="compact" dismissible={false}>
            <Mono>{history.recovering}</Mono>
          </Banner>
        </CardContent>
      ) : null}

      {error ? (
        <CardContent className="p-5">
          <Banner variant="error" size="compact" dismissible={false}>
            {walletMessage(error)}
          </Banner>
        </CardContent>
      ) : null}

      {draft ? (
        <CardContent className="p-5 flex flex-col gap-3">
          <Banner
            variant="info"
            title={`Recover ${draft.request.terms.poolName} request ${shortContract(draft.request.requestId)}`}
            size="compact"
            dismissible={false}
          >
            Nothing is recovered until the ledger confirms it.
          </Banner>
          <ul className="flex flex-col gap-1 text-sm" aria-label="What this recovery releases">
            {draft.preparation.recoveryEffects.map((effect) => (
              <li key={effect.allocationCid}>
                {recoveryLine(effect, balances, draft.request.terms.lpInstrument)}
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              loading={recover.pending}
              disabled={busy || !openPoolIds.includes(draft.request.terms.poolId)}
              onClick={async () => {
                await recover.perform(draft);
                setDraft(undefined);
                onRecovered();
              }}
            >
              Sign recovery
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDraft(undefined)}>
              Cancel
            </Button>
          </div>
        </CardContent>
      ) : null}

      <AsyncSection result={history.activity} label={`Loading ${title.toLowerCase()}`} rows={3}>
        {(page) =>
          page.items.length === 0 ? (
            <EmptyState title="Nothing here yet" />
          ) : (
            <DataTable
              aria-labelledby={titleId}
              columns={[
                { id: 'pool', header: 'Pool', cell: (request) => request.terms.poolName },
                {
                  ...NUMERIC,
                  id: 'offered',
                  header: 'Offered',
                  cell: (request) => requestAmounts(request, balances).offered,
                },
                {
                  ...NUMERIC,
                  id: 'outcome',
                  header: 'Outcome',
                  cell: (request) => requestAmounts(request, balances).outcome,
                },
                {
                  id: 'status',
                  header: 'Status',
                  cell: (request) => (
                    <StatusBadge
                      tone={liquidityStatusTones[request.status]}
                      dot={request.status === 'SETTLING'}
                      label={liquidityStatusLabels[request.status]}
                    />
                  ),
                },
                {
                  id: 'settles-by',
                  header: 'Settles by',
                  cell: (request) => formatDateTime(request.terms.settlementDeadline),
                },
                {
                  id: 'detail',
                  header: <span className="sr-only">Detail</span>,
                  cell: (request) => (
                    <div className="flex items-center justify-end gap-2">
                      {request.canRecover ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={prepare.pending && preparing === request.requestId}
                          disabled={
                            busy ||
                            draft !== undefined ||
                            !openPoolIds.includes(request.terms.poolId) ||
                            (lacksPoolAccess(error) && preparing === request.requestId)
                          }
                          onClick={() => prepare.perform(request)}
                        >
                          Recover funds
                        </Button>
                      ) : null}
                      <RequestDetail request={request} balances={balances} />
                    </div>
                  ),
                },
              ]}
              rows={page.items}
              getRowKey={(request) => request.requestId}
              className="border-0"
            />
          )
        }
      </AsyncSection>

      {history.olderCursor || history.canShowNewer ? (
        <CardContent className="p-5">
          <div className="flex items-center gap-3">
            <Button size="sm" variant="secondary" disabled={!history.canShowNewer} onClick={history.showNewer}>
              Newer
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={history.olderCursor === undefined}
              onClick={() => history.olderCursor && history.showOlder(history.olderCursor)}
            >
              Older
            </Button>
          </div>
        </CardContent>
      ) : null}
    </Card>
  );
}

function RequestDetail({
  request,
  balances,
}: {
  request: LiquidityRequest;
  balances: readonly TokenBalance[];
}) {
  const kind = request.kind === 'DEPOSIT' ? 'deposit' : 'withdrawal';
  const short = shortContract(request.requestId);
  const { offered, outcome } = requestAmounts(request, balances);
  const settled = settledItems(request, balances);
  const { lpInstrument } = request.terms;
  return (
    <DetailDialog title={`${request.terms.poolName} ${kind} ${short}`} label={`Details for ${kind} ${short}`}>
      <DataList
        items={[
          { label: 'Status', value: liquidityStatusLabels[request.status] },
          { label: 'Offered', value: offered },
          // Until a batch settles it, the outcome is the floor the trader signed.
          ...(settled.length > 0 ? settled : [{ label: 'Outcome', value: outcome }]),
          { label: 'Request', value: <Mono>{request.requestId}</Mono> },
          {
            label: 'Arrival',
            value: request.arrivalSequence === null ? 'Not queued yet' : `#${request.arrivalSequence}`,
          },
          {
            label: 'LP token',
            value: (
              <span className="flex flex-col wrap-anywhere">
                <Mono>{lpInstrument.id}</Mono>
                <span className="text-muted-foreground text-xs">
                  admin <Mono>{lpInstrument.admin}</Mono>
                </span>
              </span>
            ),
          },
          {
            label: 'Allocation references',
            value:
              request.allocationCids.length === 0 ? 'None recorded' : <References ids={request.allocationCids} />,
          },
          {
            label: 'Ledger update',
            value: request.updateId ? <Mono>{request.updateId}</Mono> : 'Not confirmed yet',
          },
          ...(request.error
            ? [{ label: 'Reported problem', value: `${request.errorCode ?? ''} ${request.error}`.trim() }]
            : []),
        ]}
      />
    </DetailDialog>
  );
}
