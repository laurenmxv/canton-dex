import { createRemoteJWKSet } from 'jose';
import { registerActivityRoutes } from './activity/routes.js';
import { CantonExternalParties } from './canton/external-parties.js';
import { ServiceCredentials } from './canton/credentials.js';
import { LedgerHttp } from './canton/http.js';
import { InteractiveTransactions } from './canton/interactive.js';
import { Ledger, ledgerReady } from './canton/ledger.js';
import { CantonLiquidityLedger } from './canton/liquidity-ledger.js';
import { CantonOnboardingLedger } from './canton/onboarding-ledger.js';
import { OperatorCommands } from './canton/operator-commands.js';
import { CantonPoolLedger } from './canton/pool-ledger.js';
import { CantonPools } from './canton/pools.js';
import { CantonSettlementLedger } from './canton/settlement-ledger.js';
import { CantonSwapLedger } from './canton/swap-ledger.js';
import { CantonTokenLedger } from './canton/token-ledger.js';
import { CantonTokenRegistry } from './canton/token-registry.js';
import { authenticate } from './iam/accounts.js';
import { deny, registerAuthentication } from './iam/authentication.js';
import { registerIamRoutes } from './iam/routes.js';
import { registerLiquidityRoutes } from './liquidity/routes.js';
import { LiquidityStore } from './liquidity/store.js';
import { LiquidityWorkflow } from './liquidity/workflow.js';
import { registerOnboardingRoutes } from './onboarding/routes.js';
import { OnboardingStore } from './onboarding/store.js';
import { OnboardingWorkflow } from './onboarding/workflow.js';
import { OperatorCommandStore } from './operations/commands.js';
import { loadConfig } from './platform/config.js';
import { createDatabase, databaseReady, requireSchema } from './platform/database.js';
import { registerHealth } from './platform/health.js';
import { createServer } from './platform/server.js';
import { startWorker } from './platform/worker.js';
import { registerPoolRoutes } from './pools/routes.js';
import { PoolStore } from './pools/store.js';
import { PoolWorkflow } from './pools/workflow.js';
import { registerSettlementRoutes } from './settlements/routes.js';
import { SettlementStore } from './settlements/store.js';
import { SettlementWorkflow } from './settlements/workflow.js';
import { registerSwapRoutes } from './swaps/routes.js';
import { SwapStore } from './swaps/store.js';
import { SwapWorkflow } from './swaps/workflow.js';
import { TokenRegistryStore } from './tokens/registry-store.js';
import { registerTokenRoutes } from './tokens/routes.js';
import { TokenStore } from './tokens/store.js';
import { TokenWorkflow } from './tokens/workflow.js';

/** The API port, which Compose publishes and health-checks. */
const HTTP_PORT = 8080;
/** The graceful-shutdown limit for active requests. */
const SHUTDOWN_TIMEOUT_MS = 30_000;
/** The fixed delay between two runs of a reconciliation loop. */
const RECONCILE_DELAY_MS = 3_000;

const config = loadConfig(process.env);
const app = createServer();
const db = createDatabase(config.database, (error) => {
  app.log.warn({ err: error }, 'Idle PostgreSQL connection failed');
});
await requireSchema(db);

const http = new LedgerHttp(config.ledgerApiUrl);
const operator = Ledger.service(http, new ServiceCredentials(config.ledgerTokenUrl, config.operator));
const onboardingLedger = new CantonOnboardingLedger(operator);
const parties = new CantonExternalParties(http, config.identityProviderId, config.issuer, app.log);
const onboardingStore = new OnboardingStore(db, parties, onboardingLedger.packageId);
const onboarding = new OnboardingWorkflow(onboardingStore, onboardingLedger, parties, app.log);
const registry = new TokenRegistryStore(db);
const tokenRegistry = new CantonTokenRegistry(registry);
const poolStore = new PoolStore(db);
const pools = new PoolWorkflow(poolStore, new CantonPoolLedger(operator, registry, tokenRegistry), registry, app.log);
const tokenStore = new TokenStore(db);
const commands = new OperatorCommands(operator, new OperatorCommandStore(db), app.log);
const interactive = new InteractiveTransactions(http);
const tokenLedger = new CantonTokenLedger(operator, interactive, tokenStore, registry, commands, app.log);
const tokens = new TokenWorkflow(tokenStore, tokenLedger, app.log);
const cantonPools = new CantonPools(operator, poolStore, tokenRegistry);
const swapStore = new SwapStore(db, config.settlementMaxBatchSize);
const swaps = new SwapWorkflow(
  swapStore,
  new CantonSwapLedger(operator, cantonPools, tokenStore, interactive, tokenRegistry),
  app.log,
);
const liquidityStore = new LiquidityStore(db, config.settlementMaxBatchSize);
const liquidityLedger = new CantonLiquidityLedger(
  operator,
  cantonPools,
  poolStore,
  tokenStore,
  interactive,
  tokenRegistry,
);
const liquidity = new LiquidityWorkflow(liquidityStore, liquidityLedger, app.log);
const settlements = new SettlementWorkflow(
  new SettlementStore(db, config.settlementMaxBatchSize),
  new CantonSettlementLedger(operator, cantonPools, commands, tokenRegistry, liquidityLedger),
  app.log,
);

registerAuthentication(app, {
  issuer: config.issuer,
  keys: createRemoteJWKSet(config.jwkSetUri),
  authenticate: (issuer, subject, name) => authenticate(db, issuer, subject, name),
});
registerHealth(app, { db: () => databaseReady(db), canton: () => ledgerReady(operator) }, deny);
registerIamRoutes(app, db);
registerOnboardingRoutes(app, onboardingStore, onboarding);
registerPoolRoutes(app, poolStore, pools);
registerTokenRoutes(app, tokens, config.developmentTokens);
registerSwapRoutes(app, swaps);
registerLiquidityRoutes(app, liquidity);
registerActivityRoutes(app, { swaps, liquidity, swapHistory: swapStore, liquidityHistory: liquidityStore });
registerSettlementRoutes(app, settlements);

await app.listen({ host: '0.0.0.0', port: HTTP_PORT });
// Each loop runs on its own; settlement recovery also runs while automatic dispatch is disabled.
const workers = [
  startWorker('onboarding', RECONCILE_DELAY_MS, () => onboarding.reconcile(), app.log),
  startWorker('pools', RECONCILE_DELAY_MS, () => pools.reconcile(), app.log),
  startWorker('swaps', RECONCILE_DELAY_MS, () => swaps.reconcile(), app.log),
  startWorker('liquidity', RECONCILE_DELAY_MS, () => liquidity.reconcile(), app.log),
  startWorker('settlement-recovery', RECONCILE_DELAY_MS, () => settlements.reconcile(), app.log),
  startWorker('settlement-automatic', RECONCILE_DELAY_MS, () => settlements.automatic(), app.log),
];

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info(`${signal} received; stopping`);
  const deadline = setTimeout(() => {
    app.log.warn('Shutdown timeout reached; closing active connections');
    app.server.closeAllConnections();
  }, SHUTDOWN_TIMEOUT_MS);
  await Promise.all([app.close(), ...workers.map((worker) => worker.stop())]);
  clearTimeout(deadline);
  await db.destroy();
  app.log.info('Stopped');
}

let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    shutdown(signal).catch((error: unknown) => {
      app.log.error({ err: error }, 'Shutdown failed');
      process.exitCode = 1;
    });
  });
}
