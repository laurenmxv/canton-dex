/**
 * Daml names of the unchanged DARs. Package ids are the deterministic hashes of those DARs; the
 * bootstrap checks the DEX package against the built DAR before uploading it.
 */
export interface DamlName {
  readonly packageName: string;
  readonly packageId: string;
  readonly module: string;
  readonly entity: string;
}

export const DEX_PACKAGE_ID = '38a7290bce72ede1d747ede7790a58e8c32fab1fa2db844de0b6dda13052a674';
export const TOKEN_PACKAGE_ID = 'dbb1f220559dd1d2e505a56449ded609f5f49708678316cf74fc37760da27f6a';
export const FAUCET_PACKAGE_ID = 'a0526f9c5bba1406cd99cc0abb3651451f8f55e3b3e57f4e44678e0a1ed9d1b5';
const HOLDING_PACKAGE_ID = 'dcf74571dd11e678637924e9f10a61a15727801c83c0f21d3218656b7e6039f8';
const ALLOCATION_PACKAGE_ID = 'e5b7ba48c44c972ea670a983647c544516841e0d9d893d86bdf17a025f4c8b4e';

const dex = (module: string, entity: string): DamlName => ({
  packageName: 'canton-dex-ri',
  packageId: DEX_PACKAGE_ID,
  module,
  entity,
});
const token = (module: string, entity: string): DamlName => ({
  packageName: 'openzeppelin-tokenCIP112-v1',
  packageId: TOKEN_PACKAGE_ID,
  module: `OpenZeppelin.TokenCIP112V1.${module}`,
  entity,
});
const faucet = (entity: string): DamlName => ({
  packageName: 'canton-dex-test-faucet',
  packageId: FAUCET_PACKAGE_ID,
  module: 'TestTokenFaucet.Faucet',
  entity,
});

export const Pool = dex('Pool', 'Pool');
export const PoolConfig = dex('Pool', 'PoolConfig');
export const PoolState = dex('Pool', 'PoolState');
export const KycAttestation = dex('KycAttestation', 'KycAttestation');
export const PoolAccess = dex('PoolAccess', 'PoolAccess');
export const PoolFactory = dex('PoolFactory', 'PoolFactory');
export const PoolProposal = dex('PoolFactory', 'PoolProposal');
export const VenueDelegation = dex('VenueDelegation', 'VenueDelegation');
export const SwapReceipt = dex('Pool', 'SwapReceipt');
export const LiquidityReceipt = dex('Pool', 'LiquidityReceipt');
export const TokenRules = token('Registry', 'TokenRules');
export const TokenHolding = token('Holding', 'TokenHolding');
export const TestTokenFaucet = faucet('TestTokenFaucet');
export const TestTokenGrant = faucet('TestTokenGrant');
export const TestTokenReceipt = faucet('TestTokenReceipt');
export const HoldingInterface: DamlName = {
  packageName: 'splice-api-token-holding-v2',
  packageId: HOLDING_PACKAGE_ID,
  module: 'Splice.Api.Token.HoldingV2',
  entity: 'Holding',
};
export const AllocationInterface: DamlName = {
  packageName: 'splice-api-token-allocation-v2',
  packageId: ALLOCATION_PACKAGE_ID,
  module: 'Splice.Api.Token.AllocationV2',
  entity: 'Allocation',
};

/** The package-name reference that filters and commands use, for example `#canton-dex-ri:Pool:Pool`. */
export function byName(name: DamlName): string {
  return `#${name.packageName}:${name.module}:${name.entity}`;
}

/** The package-id form that the participant writes in events and interface views. */
export function byPackageId(name: DamlName): string {
  return `${name.packageId}:${name.module}:${name.entity}`;
}

function parts(identifier: string): [string, string, string] {
  const [packageRef, module, entity, ...rest] = identifier.split(':');
  if (packageRef === undefined || module === undefined || entity === undefined || rest.length > 0) {
    throw new Error(`Unexpected Daml identifier ${identifier}`);
  }
  return [packageRef, module, entity];
}

export function packageOf(identifier: string): string {
  return parts(identifier)[0];
}

/** The same module and entity, from any package version. */
export function sameEntity(identifier: string, name: DamlName): boolean {
  const [, module, entity] = parts(identifier);
  return module === name.module && entity === name.entity;
}

/** The exact template of the unchanged DAR. */
export function isExactly(identifier: string, name: DamlName): boolean {
  return identifier === byPackageId(name);
}
