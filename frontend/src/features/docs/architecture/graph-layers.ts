import { model } from './content';
import { CANTON_ICON, canvas, type Graph } from './graph-base';

const N = model.N;
const context = { client: 'context-client', backend: 'context-backend' };

export function frontendGraph(): Graph {
  const { graph, node, edge } = canvas(1140, 580);
  node('frontend-boundary', 275, 0, { kind: 'boundary', label: 'Frontend application', width: 855, height: 425 });
  node(N.keycloak!, 0, 62);
  node(N.session!, 310, 55);
  node(N.trader!, 600, 55);
  node(N.operator!, 890, 55);
  node(N.externalWallet!, 0, 319);
  node(N.wallet!, 360, 312);
  node(N.data!, 690, 312);
  node(context.client, 890, 475, { kind: 'layer', layerId: 'client', label: 'Client', chips: ['Typed API'] });
  edge('frontend-login', N.keycloak!, N.session!, 'login');
  edge('frontend-trader-role', N.session!, N.trader!, 'trader');
  edge('frontend-operator-role', N.session!, N.operator!, 'operator', {
    sourceHandle: 'top-out', targetHandle: 'top-in',
    via: [{ x: 420, y: 24 }, { x: 1000, y: 24 }], labelAt: { x: 760, y: 24 },
  });
  edge('frontend-trader-api', N.trader!, N.data!, 'call / observe', {
    sourceHandle: 'bottom-out', targetHandle: 'top-in',
    via: [{ x: 710, y: 224 }, { x: 800, y: 224 }], labelAt: { x: 752, y: 224 },
  });
  edge('frontend-operator-api', N.operator!, N.data!, 'call / observe', {
    sourceHandle: 'bottom-out', targetHandle: 'top-in',
    via: [{ x: 1000, y: 270 }, { x: 800, y: 270 }], labelAt: { x: 959, y: 270 },
  });
  edge('frontend-signing', N.trader!, N.wallet!, 'request signature', {
    sourceHandle: 'left-out', targetHandle: 'top-in',
    via: [{ x: 560, y: 103 }, { x: 560, y: 250 }, { x: 470, y: 250 }], labelAt: { x: 489, y: 250 },
  });
  edge('frontend-wallet', N.wallet!, N.externalWallet!, 'hash / signature', {
    sourceHandle: 'left-out', targetHandle: 'right-in',
  });
  edge('frontend-client', N.data!, context.client, 'typed API', {
    sourceHandle: 'bottom-out', targetHandle: 'top-in',
    via: [{ x: 800, y: 445 }, { x: 1000, y: 445 }], labelAt: { x: 885, y: 445 },
  });
  return graph;
}

export function clientGraph(): Graph {
  const { graph, node, edge } = canvas(1100, 625);
  node('client-boundary', 225, 0, { kind: 'boundary', label: 'Client library · imported by the frontend', width: 625, height: 615 });
  node('client-caller', 0, 255, { kind: 'layer', layerId: 'frontend', label: 'Frontend', width: 180 });
  node(N.http!, 610, 255);
  node(context.backend, 920, 255, { kind: 'layer', layerId: 'backend', label: 'Backend', width: 180 });
  const groups = [[N.reads!, 40, 'query'], [N.onboardingApi!, 190, 'onboard'], [N.traderApi!, 340, 'request'], [N.operatorApi!, 490, 'operate']] as const;
  for (const [id, y, verb] of groups) {
    node(id, 250, y);
    edge(`client-calls-${id}`, 'client-caller', id, 'calls', {
      via: [{ x: 207, y: 303 }, { x: 207, y: y + 48 }], labelAt: { x: 206, y: y + 31 },
    });
    edge(`client-http-${id}`, id, N.http!, verb, {
      via: [{ x: 550, y: y + 48 }, { x: 550, y: 303 }], labelAt: { x: 511, y: y + 48 },
    });
  }
  edge('client-backend', N.http!, context.backend, 'HTTP + token');
  return graph;
}

/** The participant that serves the Ledger API. It is a boundary, not a service box. */
export const PARTICIPANT = 'backend-participant';

/**
 * The Backend's components and relations. It has no layout: the drawn view, `backendDisplayGraph()`,
 * places every component and draws each relation, or a group of them, with an authored route.
 */
export function backendGraph(): Graph {
  const { graph, node, edge } = canvas(0, 0);
  const size = { width: 180, height: 64 };
  const at = (id: string, options: Parameters<typeof node>[3] = {}) => node(id, 0, 0, { ...size, ...options });

  at('backend-boundary', { kind: 'boundary', label: 'Backend' });
  at(PARTICIPANT, { kind: 'boundary', label: 'Canton participant' });
  at(context.client, { kind: 'layer', layerId: 'client', label: 'Client' });
  at(N.api!, { icon: 'server' });
  at(N.iam!, { icon: 'identity' });
  at(N.activity!);
  at(N.application!);
  at(N.platform!, { icon: 'server' });
  for (const id of [N.onboarding!, N.pools!, N.swaps!, N.liquidity!, N.tokens!]) at(id);
  at(N.settlementQueues!, { icon: 'database' });
  at(N.settlementDecision!);
  at(N.settlements!, { label: 'Execution & recovery' });
  at(N.settlementAutomation!);
  at(N.adapters!);
  at(N.operations!);
  at(N.stores!);
  at(N.dbClient!, { icon: 'database' });
  at(N.database!);
  at(N.ledgerApi!, { kind: 'context', layerId: 'canton' });
  at(N.synchronizer!, { kind: 'context', icon: CANTON_ICON });
  at(N.dvo!, { kind: 'context', icon: 'identity' });

  edge('backend-client', context.client, N.api!, 'HTTP');
  edge('backend-authenticate', N.api!, N.iam!, 'onRequest');
  edge('backend-compose-router', N.application!, N.api!, 'register routes', { structural: true });
  edge('backend-platform', N.application!, N.platform!, 'utilities', { structural: true });
  edge('backend-activity-route', N.api!, N.activity!, 'history');
  // The source TSDoc explains the read-only workflow facades used by filtered views.
  edge('backend-activity-history', N.activity!, N.stores!, 'reads history');
  const business = [N.onboarding!, N.pools!, N.swaps!, N.liquidity!, N.tokens!];
  for (const [index, id] of business.entries()) {
    const first = index === 0;
    edge(`backend-route-${id}`, N.api!, id, first ? 'routes' : '');
    edge(`backend-ledger-${id}`, id, N.adapters!, first ? 'ledger ports' : '');
    edge(`backend-persist-${id}`, id, N.stores!, first ? 'records' : '');
  }

  // Settlement, as a logical flow: durable queues feed the planner, and the planned batch runs on the
  // ledger. SettlementWorkflow is the entry point in code; SettlementStore.claim applies the planner.
  // A manual run is planned like an automatic one: through the queue claim and FIFO selection.
  edge('backend-route-settlement', N.api!, N.settlementDecision!, 'manual');
  edge('backend-settlement-automatic', N.settlementAutomation!, N.settlementDecision!, 'automatic');
  edge('backend-settlement-recovery', N.settlementAutomation!, N.settlements!, 'recovery');
  edge('backend-settlement-queue', N.settlementQueues!, N.settlementDecision!, 'FIFO order');
  edge('backend-settlement-plan', N.settlementDecision!, N.settlements!, 'batch');
  edge('backend-settlement-progress', N.settlements!, N.settlementQueues!, 'claim / confirm');
  edge(`backend-ledger-${N.settlements}`, N.settlements!, N.adapters!, 'ledger operations');
  // Queues read and update the request rows that Swaps and Liquidity admit: one set of rows, no copy or broker.
  edge('backend-shared-requests', N.stores!, N.settlementQueues!, 'shared request rows', { structural: true });
  edge('backend-queue-queries', N.settlementQueues!, N.dbClient!, 'queries');

  edge('backend-command-journal', N.adapters!, N.operations!, 'command journal');
  edge('backend-queue-helpers', N.stores!, N.operations!, 'queue helpers');
  // Stores, queues, IAM accounts and the Operations journal share one client; only it speaks SQL.
  edge('backend-command-sql', N.operations!, N.dbClient!, 'journal');
  edge('backend-store-queries', N.stores!, N.dbClient!, 'queries');
  edge('backend-sql', N.dbClient!, N.database!, 'SQL');
  // Account queries belong to IAM, independently of the domain-store grouping.
  edge('backend-accounts-sql', N.iam!, N.dbClient!, 'accounts');

  edge('backend-ledger-api', N.adapters!, N.ledgerApi!, 'Ledger API');
  edge('backend-synchronizer', PARTICIPANT, N.synchronizer!, 'connected to', { structural: true });
  return graph;
}
