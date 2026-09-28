import { Conflict } from '../platform/errors.js';
import type { RegistryDisclosure, TokenSource } from '../tokens/registry-store.js';
import type { Token } from './contracts.js';
import { EMPTY_EXTRA_ARGS, type DisclosedContract } from './ledger.js';

/** The stored issuer factories that the registry reads. */
export interface TokenSources {
  source(admin: string): Promise<TokenSource | undefined>;
  disclosures(admin: string, factoryCid: string): Promise<RegistryDisclosure[]>;
}

/** A token-standard call on an issuer factory, with the contracts the command discloses. */
export interface TokenOperation {
  readonly factoryCid: string;
  readonly extraArgs: typeof EMPTY_EXTRA_ARGS;
  readonly disclosures: readonly DisclosedContract[];
}

const REGISTRY_UNAVAILABLE = 'TOKEN_REGISTRY_UNAVAILABLE';

/** One disclosure per contract; the same contract disclosed differently is an error. */
export function mergeDisclosures(disclosures: readonly DisclosedContract[]): DisclosedContract[] {
  const unique = new Map<string, DisclosedContract>();
  for (const disclosure of disclosures) {
    const existing = unique.get(disclosure.contractId);
    if (!existing) unique.set(disclosure.contractId, disclosure);
    else if (
      existing.templateId !== disclosure.templateId ||
      existing.createdEventBlob !== disclosure.createdEventBlob ||
      existing.synchronizerId !== disclosure.synchronizerId
    ) {
      throw new Error('Conflicting disclosures for the same contract');
    }
  }
  return [...unique.values()];
}

/** The pool's approved factory must still be the issuer's configured one. */
export function requireFactory(expected: string, operation: TokenOperation): TokenOperation {
  if (expected !== operation.factoryCid) {
    throw new Conflict('Token registry factory differs from the factory approved by the pool', 'TOKEN_FACTORY_CHANGED');
  }
  return operation;
}

/** The token's approved factories are still its issuer's configured ones. */
export async function approvedOperations(
  registry: Pick<CantonTokenRegistry, 'inlineAllocation' | 'inlineSettlement'>,
  token: Token,
): Promise<{ allocation: TokenOperation; settlement: TokenOperation }> {
  const allocation = requireFactory(token.allocationFactory, await registry.inlineAllocation(token.instrument.admin));
  const settlement = requireFactory(token.settlementFactory, await registry.inlineSettlement(token.instrument.admin));
  return { allocation, settlement };
}

function disclosure(contract: RegistryDisclosure): DisclosedContract {
  const parts = contract.templateId.split(':');
  if (parts.length !== 3 || parts.some((part) => part.trim() === '')) {
    throw new Error('Token registry contains an invalid template identifier');
  }
  return {
    templateId: contract.templateId,
    contractId: contract.contractId,
    createdEventBlob: contract.createdEventBlob,
    synchronizerId: contract.synchronizerId,
  };
}

/** Configured issuer factories for synchronous operations that need no choice context. */
export class CantonTokenRegistry {
  constructor(private readonly sources: TokenSources) {}

  async inlineAllocation(admin: string): Promise<TokenOperation> {
    const source = await this.source(admin);
    return this.operation(source, source.allocationFactoryId);
  }

  async inlineSettlement(admin: string): Promise<TokenOperation> {
    const source = await this.source(admin);
    return this.operation(source, source.settlementFactoryId);
  }

  async withdraw(admin: string, allocationCid: string): Promise<TokenOperation> {
    const allocation = await this.inlineAllocation(admin);
    return { factoryCid: allocationCid, extraArgs: EMPTY_EXTRA_ARGS, disclosures: allocation.disclosures };
  }

  private async source(admin: string): Promise<TokenSource> {
    const source = await this.sources.source(admin);
    if (!source) throw new Conflict(`Token registry is not configured for ${admin}`, REGISTRY_UNAVAILABLE);
    return source;
  }

  private async operation(source: TokenSource, factoryCid: string): Promise<TokenOperation> {
    const contracts = await this.sources.disclosures(source.admin, factoryCid);
    if (contracts.length === 0) {
      throw new Conflict(`Token registry factory disclosure is missing for ${source.admin}`, REGISTRY_UNAVAILABLE);
    }
    return { factoryCid, extraArgs: EMPTY_EXTRA_ARGS, disclosures: contracts.map(disclosure) };
  }
}
