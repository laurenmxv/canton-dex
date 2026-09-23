import {
  Banner,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@openzeppelin/ui-components';
import type { ReactNode } from 'react';
import type {
  DepositResult,
  InstrumentId,
  Settlement,
  SettlementFill,
  WithdrawalResult,
} from '../../lib/api/types';
import { formatExact } from '../../lib/decimal';
import {
  formatCountdown,
  formatDateTime,
  requestTypeLabels,
  settlementStatusLabels,
  shortContract,
  shortParty,
} from '../../lib/labels';
import { StatusBadge } from '../../ui/Badge';
import { DataList } from '../../ui/Card';
import { CopyField } from '../../ui/CopyField';
import { Disclosure } from '../../ui/Disclosure';
import { Mono } from '../../ui/Mono';
import { amount, holdLabels, type QueueRow } from './queueRows';

type Item = { label: string; value: ReactNode };

function both(base: string, quote: string, baseId: InstrumentId, quoteId: InstrumentId): string {
  return `${amount(base, baseId)} + ${amount(quote, quoteId)}`;
}

function instrument(label: string, value: InstrumentId): Item {
  return {
    label,
    value: (
      <span className="flex flex-col wrap-anywhere">
        <Mono>{value.id}</Mono>
        <span className="text-muted-foreground text-xs">
          admin <Mono>{value.admin}</Mono>
        </span>
      </span>
    ),
  };
}

/** A settled deposit's outcome, read from its own result or from its batch's fill. */
function depositOutcome(result: DepositResult, base: InstrumentId, quote: InstrumentId): Item[] {
  return [
    { label: 'Accepted', value: both(result.actualBaseIn, result.actualQuoteIn, base, quote) },
    { label: 'Refunded', value: both(result.actualBaseRefund, result.actualQuoteRefund, base, quote) },
    { label: 'LP minted', value: amount(result.actualLpOut, 'LP') },
  ];
}

/** A settled withdrawal's outcome, read from its own result or from its batch's fill. */
function withdrawalOutcome(result: WithdrawalResult, base: InstrumentId, quote: InstrumentId): Item[] {
  return [
    { label: 'LP burned', value: amount(result.actualLpBurned, 'LP') },
    { label: 'Paid out', value: both(result.actualBaseOut, result.actualQuoteOut, base, quote) },
  ];
}

/** Family-specific facts, each kept apart by how binding it is. */
function sections(row: QueueRow): {
  instruments: Item[];
  signed: Item[];
  expected: Item[];
  result: Item[] | null;
} {
  const { entry } = row;
  if (entry.type === 'swap') {
    const swap = entry.request;
    return {
      instruments: [instrument('Input', swap.inputInstrument), instrument('Output', swap.outputInstrument)],
      signed: [
        { label: 'Direction', value: swap.direction === 'BaseToQuote' ? 'Base to quote' : 'Quote to base' },
        { label: 'Amount in', value: amount(swap.amountIn, swap.inputInstrument) },
        { label: 'Minimum out', value: amount(swap.minOut, swap.outputInstrument) },
      ],
      expected: [
        { label: 'Expected out', value: amount(swap.expectedOut, swap.outputInstrument) },
        { label: 'Fee', value: amount(swap.feeAmount, swap.inputInstrument) },
      ],
      result:
        swap.amountOut === null
          ? null
          : [{ label: 'Paid out', value: amount(swap.amountOut, swap.outputInstrument) }],
    };
  }
  if (entry.type === 'deposit') {
    const { terms, result } = entry.request;
    const { baseInstrument: base, quoteInstrument: quote } = terms;
    return {
      instruments: [instrument('Base', base), instrument('Quote', quote), instrument('LP', terms.lpInstrument)],
      signed: [
        { label: 'Mode', value: terms.mode === 'INITIAL' ? 'Initial, at the configured ratio' : 'Proportional to reserves' },
        { label: 'Maximum in', value: both(terms.maxBaseAmount, terms.maxQuoteAmount, base, quote) },
        { label: 'Minimum LP', value: amount(terms.minLpOut, 'LP') },
        { label: 'Ratio bounds', value: `${formatExact(terms.minRatio)} – ${formatExact(terms.maxRatio)} ${quote.id} per ${base.id}` },
        ...(terms.initialMinimumLp === null
          ? []
          : [{ label: 'Locked minimum LP', value: amount(terms.initialMinimumLp, 'LP') }]),
      ],
      expected: [
        { label: 'Expected in', value: both(terms.expectedBaseAmount, terms.expectedQuoteAmount, base, quote) },
        { label: 'Expected refund', value: both(terms.expectedBaseRefund, terms.expectedQuoteRefund, base, quote) },
        { label: 'Expected LP', value: amount(terms.expectedLpOut, 'LP') },
      ],
      result: result && depositOutcome(result, base, quote),
    };
  }
  const { terms, result } = entry.request;
  const { baseInstrument: base, quoteInstrument: quote } = terms;
  return {
    instruments: [instrument('Base', base), instrument('Quote', quote), instrument('LP', terms.lpInstrument)],
    signed: [
      { label: 'LP to burn', value: amount(terms.lpAmount, 'LP') },
      { label: 'Minimum out', value: both(terms.minBaseOut, terms.minQuoteOut, base, quote) },
    ],
    expected: [{ label: 'Expected out', value: both(terms.expectedBaseOut, terms.expectedQuoteOut, base, quote) }],
    result: result && withdrawalOutcome(result, base, quote),
  };
}

function fillItems(row: QueueRow, fill: SettlementFill): Item[] {
  if (fill.type === 'swap') return [{ label: 'Paid out', value: amount(fill.amountOut, fill.outputInstrument) }];
  if (row.entry.type === 'swap') return [];
  const { baseInstrument: base, quoteInstrument: quote } = row.entry.request.terms;
  return fill.type === 'deposit' ? depositOutcome(fill, base, quote) : withdrawalOutcome(fill, base, quote);
}

/**
 * The batch that carried this request. A confirmed batch listing it wins over
 * any cached reading, since the queue and the batches poll independently and a
 * fast settlement can leave the queue before its settlement id is ever read.
 * Otherwise the attempt it names, or the latest one listing it.
 */
function evidence(row: QueueRow, batches: readonly Settlement[] | undefined) {
  const { settlementId } = row.entry.request;
  const lists = (batch: Settlement) =>
    batch.requests.some((ref) => ref.type === row.family && ref.requestId === row.requestId);
  const batch =
    batches?.find((candidate) => candidate.status === 'CONFIRMED' && lists(candidate)) ??
    (settlementId ? batches?.find((candidate) => candidate.settlementId === settlementId) : undefined) ??
    batches?.find(lists);
  const fill = batch?.fills.find((one) => one.type === row.family && one.requestId === row.requestId);
  return { batch, fill };
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-muted-foreground text-[0.6875rem] font-semibold tracking-[0.05em] uppercase">{title}</h3>
      {children}
    </section>
  );
}

/**
 * Everything the venue reported about one queued request. It stays open on
 * the last reading after the request leaves the active queue, and says so.
 */
export function RequestDetail({
  row,
  left,
  batches,
  now,
  onClose,
  onCloseAutoFocus,
}: {
  row: QueueRow | undefined;
  /** True once the request is no longer in the active queue this screen reads. */
  left: boolean;
  batches: readonly Settlement[] | undefined;
  now: number;
  onClose: () => void;
  /** Returns focus to where the operator was, since no dialog trigger owns it. */
  onCloseAutoFocus: () => void;
}) {
  return (
    <Dialog open={row !== undefined} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onCloseAutoFocus();
        }}
      >
        {row ? <Body row={row} left={left} batches={batches} now={now} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function Body({
  row,
  left,
  batches,
  now,
}: {
  row: QueueRow;
  left: boolean;
  batches: readonly Settlement[] | undefined;
  now: number;
}) {
  const request = row.entry.request;
  const facts = sections(row);
  const { batch, fill } = evidence(row, batches);
  const confirmed = batch?.status === 'CONFIRMED';
  const result = facts.result ?? (confirmed && fill ? fillItems(row, fill) : null);
  // A confirmed outcome outranks whatever status or error the last queue read carried.
  const settled = result !== null;
  const status = settled ? { tone: 'success' as const, label: 'Settled' } : row;

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {requestTypeLabels[row.family]} {shortContract(row.requestId)}
        </DialogTitle>
        <DialogDescription asChild>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <StatusBadge tone={status.tone} label={status.label} />
            {row.deferred && !settled ? <StatusBadge tone="neutral" dot label={holdLabels.deferred} /> : null}
            <span>{row.arrivalSequence === null ? 'Not queued yet' : `Arrival #${row.arrivalSequence}`}</span>
            <span>
              Trader <Mono>{shortParty(row.trader)}</Mono>
            </span>
            <span>
              Settles by {formatDateTime(row.settlementDeadline)} ({formatCountdown(row.settlementDeadline, now)})
            </span>
          </div>
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-5">
        {left ? (
          <Banner
            variant={settled ? 'success' : 'info'}
            title="No longer in the active queue"
            size="compact"
            dismissible={false}
          >
            {!settled
              ? `Outcome not observed. Last known status: ${row.label}, read ${formatDateTime(request.updatedAt)}.`
              : confirmed
                ? `Settled in confirmed batch ${shortContract(batch.settlementId)}.`
                : 'Settled.'}
          </Banner>
        ) : null}
        {row.error && !settled ? (
          <Banner variant="warning" title={request.errorCode ?? 'Reported problem'} size="compact" dismissible={false}>
            {row.error}
          </Banner>
        ) : null}

        <Section title="Signed terms">
          <DataList items={facts.signed} />
        </Section>

        <Section title="Confirmed result">
          {result ? (
            <DataList items={result} />
          ) : (
            <p className="text-muted-foreground text-sm">{left ? 'Outcome not observed.' : 'Not settled yet.'}</p>
          )}
        </Section>

        <Section title="Quoted estimate, not binding">
          <DataList items={facts.expected} />
        </Section>

        <Disclosure summary="Identifiers, instruments and ledger evidence">
          <CopyField label="Request ID" value={row.requestId} />
          <CopyField label="Quote ID" value={row.quoteId} />
          <CopyField label="Trader" value={row.trader} />
          <DataList items={facts.instruments} />
          <DataList
            items={[
              { label: 'Created', value: formatDateTime(request.createdAt) },
              { label: 'Submitted', value: request.submittedAt ? formatDateTime(request.submittedAt) : 'Not submitted' },
              { label: 'Updated', value: formatDateTime(request.updatedAt) },
              ...(batch
                ? [
                    { label: 'Batch status', value: settlementStatusLabels[batch.status] },
                    ...(fill && !confirmed
                      ? fillItems(row, fill).map((item) => ({ label: `Projected · ${item.label}`, value: item.value }))
                      : []),
                  ]
                : []),
            ]}
          />
          {request.updateId ? <CopyField label="Request ledger update" value={request.updateId} /> : null}
          {batch ? <CopyField label="Settlement" value={batch.settlementId} /> : null}
          {batch?.updateId ? <CopyField label="Batch ledger update" value={batch.updateId} /> : null}
          {row.allocationCids.length === 0 ? (
            <p className="text-muted-foreground">No allocations recorded.</p>
          ) : (
            row.allocationCids.map((cid, index) => (
              <CopyField key={cid} label={`Allocation ${index + 1}`} value={cid} />
            ))
          )}
        </Disclosure>
      </div>
    </>
  );
}
