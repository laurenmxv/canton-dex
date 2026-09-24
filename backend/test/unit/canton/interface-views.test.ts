import { describe, expect, it } from 'vitest';
import { createdEvent, interfaceView, transactionFilter } from '../../../src/canton/ledger.js';
import { AllocationInterface, byName, byPackageId, HoldingInterface } from '../../../src/canton/packages.js';

const VALUE = { token: 'foreign-instrument' };

function view(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    interfaceId: byPackageId(HoldingInterface),
    viewStatus: { code: 0, message: '' },
    viewValue: VALUE,
    ...overrides,
  };
}

function event(...views: Record<string, unknown>[]) {
  return createdEvent({
    offset: 1,
    contractId: 'foreign-contract',
    templateId: 'foreign-package:Issuer.Asset:Balance',
    createArgument: {},
    interfaceViews: views,
    signatories: ['issuer'],
    createdAt: '2026-01-01T00:00:00Z',
  });
}

describe('interface views', () => {
  it('decodes the view regardless of the issuer template and payload', () => {
    expect(interfaceView(event(view()), HoldingInterface)).toEqual(VALUE);
  });

  it('does not accept an interface from another package', () => {
    const other = view({ interfaceId: 'other-standard-version:Splice.Api.Token.HoldingV2:Holding' });
    expect(() => interfaceView(event(other), HoldingInterface)).toThrow('Expected one');
  });

  it('fails for a missing or duplicate view', () => {
    expect(() => interfaceView(event(), HoldingInterface)).toThrow('Expected one');
    expect(() => interfaceView(event(view(), view()), HoldingInterface)).toThrow('Expected one');
  });

  it('never treats a failed view as empty or decoded', () => {
    const failed = view({ viewStatus: { code: 9, message: 'failed' } });
    expect(() => interfaceView(event(failed), HoldingInterface)).toThrow('status 9');
  });

  it('fails for an absent view value', () => {
    expect(() => interfaceView(event(view({ viewValue: undefined })), HoldingInterface)).toThrow('no value');
  });

  it('requests allocations in the transaction filter and retains other events', () => {
    const filter = transactionFilter();
    expect(filter.cumulative).toHaveLength(2);
    expect(filter.cumulative?.[0]?.identifierFilter).toHaveProperty('WildcardFilter');
    expect(filter.cumulative?.[1]?.identifierFilter).toEqual({
      InterfaceFilter: {
        value: { interfaceId: byName(AllocationInterface), includeInterfaceView: true, includeCreatedEventBlob: true },
      },
    });
  });
});
