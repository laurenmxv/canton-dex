import { join } from 'node:path';
import { sql } from 'kysely';
import { CantonAdmin } from '../canton/admin.js';
import { ServiceCredentials } from '../canton/credentials.js';
import { LedgerHttp } from '../canton/http.js';
import { Ledger } from '../canton/ledger.js';
import { DEX_PACKAGE_ID } from '../canton/packages.js';
import { TestTokenFixture } from '../canton/test-tokens.js';
import { loadBootstrapConfig } from '../platform/config.js';
import { createDatabase } from '../platform/database.js';
import { SqlFixtureStore } from './fixture-store.js';
import { DevelopmentFixtures } from './fixtures.js';
import { KeycloakFixtures } from './keycloak.js';
import { initializeSchema, requireCurrentGeneration } from './schema.js';

/** The DARs that contract-builder writes; both packages are uploaded and vetted. */
const DARS = ['canton-dex-ri-0.1.0.dar', 'canton-dex-test-faucet-0.1.0.dar'];
/** The Keycloak subject of the development operator in the Dex realm. */
const OPERATOR_SUBJECT = '00000000-0000-0000-0000-000000000003';
const OPERATOR_USERNAME = 'operator';
/** Serializes concurrent bootstrap runs against one application database. */
const BOOTSTRAP_LOCK = 4_202_609;

const config = loadBootstrapConfig(process.env);
const db = createDatabase(config.database, (error) => {
  console.warn('Idle PostgreSQL connection failed', error);
});

async function bootstrap(): Promise<void> {
  await initializeSchema(db);
  await requireCurrentGeneration(db);
  const http = new LedgerHttp(config.ledgerApiUrl);
  const administrator = Ledger.service(http, new ServiceCredentials(config.ledgerTokenUrl, config.administrator));
  const admin = new CantonAdmin(administrator);
  for (const dar of DARS) await admin.uploadAndVet(join(config.darDirectory, dar));
  if (!(await administrator.hasPackage(DEX_PACKAGE_ID))) {
    throw new Error(`The built DAR does not contain the DEX package ${DEX_PACKAGE_ID} that this backend encodes`);
  }
  const keycloak = new KeycloakFixtures(config.keycloakUrl, config.keycloakUsername, config.keycloakPassword);
  await keycloak.enableRegistration();
  await admin.ensureBrowserOperator(
    config.identityProviderId,
    config.issuer,
    config.jwkSetUri.href,
    OPERATOR_SUBJECT,
    await keycloak.userToken(OPERATOR_USERNAME, config.operatorPassword),
  );
  const fixtures = new DevelopmentFixtures(db, admin, keycloak, http, config.ledgerTokenUrl);
  const dvo = await fixtures.actor('dvo');
  const issuer = await fixtures.actor('test-token-issuer-cip112');
  const operator = await fixtures.actor('operator', config.operator, [dvo.party]);
  await fixtures.account('operator', config.issuer, OPERATOR_SUBJECT, 'OPERATOR');
  await fixtures.venueConfiguration(await operator.ledger.singleSynchronizer(), await admin.participantId());
  const tokens = await TestTokenFixture.create(new SqlFixtureStore(db), issuer.ledger, dvo.ledger, operator.ledger);
  await tokens.initialize();
}

try {
  await db.connection().execute(async (lock) => {
    await sql`SELECT pg_advisory_lock(${BOOTSTRAP_LOCK})`.execute(lock);
    try {
      await bootstrap();
    } finally {
      await sql`SELECT pg_advisory_unlock(${BOOTSTRAP_LOCK})`.execute(lock);
    }
  });
  console.log('Bootstrap complete: funded BTC/USDC and ETH/USDC test pools and self-registration ready.');
} finally {
  await db.destroy();
}
