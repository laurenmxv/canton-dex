/**
 * The local development DVO approver: `decide-pool.sh accept PROPOSAL_UUID INITIAL_RATIO` or
 * `reject PROPOSAL_UUID`. It acts with the fixture DVO identity, never the web operator's.
 */
import { fixtureParty } from '../bootstrap/fixtures.js';
import { fixtureClientSecret } from '../bootstrap/keycloak.js';
import { ServiceCredentials } from '../canton/credentials.js';
import { LedgerHttp } from '../canton/http.js';
import { Ledger } from '../canton/ledger.js';
import { decideProposal, type Decision } from '../canton/pool-ledger.js';
import { CantonTokenRegistry } from '../canton/token-registry.js';
import { loadDecisionConfig, type DecisionConfig } from '../platform/config.js';
import { createDatabase, type Db } from '../platform/database.js';
import { decimalLiteralPlainText } from '../platform/decimal.js';
import { pathUuid } from '../platform/request.js';
import { PoolStore } from '../pools/store.js';
import { TokenRegistryStore } from '../tokens/registry-store.js';

const USAGE = 'Usage: decide-pool.sh accept PROPOSAL_UUID INITIAL_RATIO | reject PROPOSAL_UUID';
const DVO = 'dvo';

/** The command's arguments; the ratio stays text until the decision. */
function command(args: readonly string[]): { readonly proposalId: string; readonly ratio: string | undefined } {
  const [action, proposal, ratio] = args;
  const valid = proposal !== undefined && (action === 'reject' || (action === 'accept' && args.length === 3));
  if (!valid) throw new Error(USAGE);
  return { proposalId: proposalUuid(proposal), ratio: action === 'accept' ? ratio : undefined };
}

function proposalUuid(value: string): string {
  try {
    return pathUuid(value);
  } catch {
    throw new Error(`Invalid UUID string: ${value}`);
  }
}

/** A decision; the ratio is any decimal literal, relayed exactly as plain text. */
function decision(ratio: string | undefined): Decision {
  return ratio === undefined ? { accept: false } : { accept: true, initialRatio: decimalLiteralPlainText(ratio) };
}

async function decide(db: Db, config: DecisionConfig, args: readonly string[]): Promise<string[]> {
  const { proposalId, ratio } = command(args);
  const accept = ratio !== undefined;
  const proposal = await new PoolStore(db).get(proposalId);
  if (!accept && proposal.status === 'REJECTED') return [`Proposal already rejected: ${proposalId}`];
  if (proposal.status !== 'PENDING' && !(accept && proposal.status === 'CREATED')) {
    throw new Error(`Proposal must be confirmed pending; current status: ${proposal.status}`);
  }
  const actor = await fixtureParty(db, DVO);
  const identity = {
    userId: actor.userId,
    clientId: actor.clientId,
    clientSecret: process.env.DEX_DVO_CLIENT_SECRET ?? fixtureClientSecret(DVO),
  };
  const ledger = Ledger.service(
    new LedgerHttp(config.ledgerApiUrl),
    new ServiceCredentials(config.ledgerTokenUrl, identity),
  );
  if ((await ledger.primaryParty()) !== actor.party) throw new Error('dvo identity mismatch');
  const registry = new CantonTokenRegistry(new TokenRegistryStore(db));
  const update = await decideProposal(ledger, registry, proposal, decision(ratio));
  const action = accept ? 'accept' : 'reject';
  return [
    `Confirmed ${action} for ${proposalId}; ledger update: ${update}`,
    'The dashboard will refresh automatically.',
  ];
}

const config = loadDecisionConfig(process.env);
const db = createDatabase(config.database, (error) => {
  console.warn('Idle PostgreSQL connection failed', error);
});
try {
  for (const line of await decide(db, config, process.argv.slice(2))) console.log(line);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
