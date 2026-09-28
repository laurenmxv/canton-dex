import { describe, expect, it } from 'vitest';
import {
  approvedOperations,
  CantonTokenRegistry,
  mergeDisclosures,
  requireFactory,
  type TokenSources,
} from '../../../src/canton/token-registry.js';
import { Conflict } from '../../../src/platform/errors.js';
import { problemFor } from '../../../src/platform/problems.js';
import type { RegistryDisclosure } from '../../../src/tokens/registry-store.js';

function registry(disclosures: Readonly<Record<string, RegistryDisclosure>>): CantonTokenRegistry {
  const sources: TokenSources = {
    source: (admin) =>
      Promise.resolve(
        ['alice', 'bob'].includes(admin)
          ? { admin, allocationFactoryId: `${admin}-allocation`, settlementFactoryId: `${admin}-settlement` }
          : undefined,
      ),
    disclosures: (_admin, factoryCid) => {
      const disclosure = disclosures[factoryCid];
      return Promise.resolve(disclosure ? [disclosure] : []);
    },
  };
  return new CantonTokenRegistry(sources);
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected a failure');
}

function disclosure(contractId: string, templateId: string, synchronizerId: string): RegistryDisclosure {
  return { templateId, contractId, createdEventBlob: 'AQID', synchronizerId };
}

describe('token registry', () => {
  it('preserves independent issuer factories and concrete disclosures', async () => {
    const tokens = registry({
      'alice-allocation': disclosure('alice-allocation', 'package-a:Token:Allocate', 'sync-a'),
      'alice-settlement': disclosure('alice-settlement', 'package-b:Other:Settle', 'sync-a'),
      'bob-allocation': disclosure('bob-allocation', 'package-c:Issuer:Factory', 'sync-b'),
    });
    const { allocation: allocated, settlement: settled } = await approvedOperations(tokens, {
      instrument: { admin: 'alice', id: 'TOKEN' },
      allocationFactory: 'alice-allocation',
      settlementFactory: 'alice-settlement',
      decimals: 10n,
    });
    const otherIssuer = await tokens.inlineAllocation('bob');
    expect(allocated.factoryCid).toBe('alice-allocation');
    expect(settled.factoryCid).toBe('alice-settlement');
    expect(otherIssuer.factoryCid).toBe('bob-allocation');
    expect(settled.disclosures[0]?.templateId.split(':')[0]).toBe('package-b');
    expect(settled.disclosures[0]?.templateId.split(':')[2]).toBe('Settle');
    expect(otherIssuer.disclosures[0]?.synchronizerId).toBe('sync-b');
    expect([...Buffer.from(allocated.disclosures[0]?.createdEventBlob ?? '', 'base64')]).toEqual([1, 2, 3]);
    expect(allocated.extraArgs.context.values).toEqual({});
    expect(allocated.extraArgs.meta.values).toEqual({});
    expect((await tokens.withdraw('alice', 'allocation')).factoryCid).toBe('allocation');
  });

  it('requires a registered issuer and a factory disclosure', async () => {
    const tokens = registry({});
    for (const admin of ['unknown', 'alice']) {
      const failure = await tokens.inlineAllocation(admin).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Conflict);
      expect(failure instanceof Conflict && failure.code).toBe('TOKEN_REGISTRY_UNAVAILABLE');
      expect(problemFor(failure)?.status).toBe(409);
    }
    const malformed = registry({ 'alice-allocation': disclosure('alice-allocation', 'invalid', 'sync') });
    await expect(malformed.inlineAllocation('alice')).rejects.toThrow('invalid template identifier');
  });

  it('rejects a factory replacement and conflicting disclosures', async () => {
    const tokens = registry({ 'alice-allocation': disclosure('alice-allocation', 'pkg:Token:Factory', 'sync') });
    const allocation = await tokens.inlineAllocation('alice');
    expect(requireFactory('alice-allocation', allocation)).toBe(allocation);
    const replaced = thrown(() => requireFactory('unapproved-factory', allocation));
    expect(replaced).toBeInstanceOf(Conflict);
    expect(replaced).toMatchObject({ code: 'TOKEN_FACTORY_CHANGED' });
    const [original] = allocation.disclosures;
    if (!original) throw new Error('No disclosure');
    expect(mergeDisclosures([original, original])).toEqual([original]);
    expect(() => mergeDisclosures([original, { ...original, synchronizerId: 'different-sync' }])).toThrow(
      'Conflicting disclosures',
    );
  });
});
