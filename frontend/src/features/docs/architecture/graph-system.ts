import { model } from './content';
import { CANTON_ICON, canvas, type Graph } from './graph-base';

const N = model.N;

export function systemGraph(): Graph {
  const { graph, node, edge } = canvas(1120, 942);

  node('band-browser', 220, 0, {
    kind: 'boundary', label: 'Browser', width: 900, height: 246, band: true,
  });
  node('band-backend', 220, 285, {
    kind: 'boundary', label: 'Backend', width: 900, height: 417, band: true,
  });
  node('band-canton', 220, 742, {
    kind: 'boundary', label: 'Canton participant', width: 620, height: 195, band: true,
  });

  node(N.keycloak!, 0, 0, { width: 180, chips: ['Login + Ledger API'] });
  node(N.externalWallet!, 0, 120, { width: 180 });
  // One frontend, two role workspaces. The container still opens the Frontend layer.
  node('layer-frontend', 240, 66, { kind: 'layer', layerId: 'frontend', width: 520, height: 170, container: true });
  node(N.trader!, 260, 132, { label: 'Trader', icon: 'identity', width: 220, height: 58 });
  node(N.operator!, 520, 132, { label: 'Operator', icon: 'identity', width: 220, height: 58 });
  node('layer-client', 840, 113, { kind: 'layer', layerId: 'client', chips: ['Typed APIs', 'HTTP'] });

  node('sys-workflows', 250, 326, {
    kind: 'layer', layerId: 'backend', label: 'Workflows', chips: ['Onboarding', 'Pools', 'Trading'],
  });
  node('layer-backend', 570, 326, {
    kind: 'layer', layerId: 'backend', entityId: N.api!, label: 'Fastify API', chips: ['Auth', 'Routes'],
  });
  node(N.settlements!, 870, 326);
  node(N.stores!, 250, 467);
  node(N.adapters!, 570, 467);
  // Stores own the queries; the shared client is the backend's only path to PostgreSQL.
  node(N.dbClient!, 250, 600, { height: 82, icon: 'database', chips: model.nodes[N.dbClient!]!.chips });
  node(N.database!, 0, 600, { width: 180 });

  node(N.tokenStandard!, 0, 795, { width: 180, chips: ['On-ledger interfaces'] });
  node('layer-contracts', 250, 788, { kind: 'layer', layerId: 'contracts', chips: ['Access', 'Pools', 'Settlement'] });
  // Runtime context for the contracts. It explains Canton on hover and has no drill-down view.
  node('canton-runtime', 570, 788, {
    layerId: 'canton', label: 'Ledger runtime', chips: ['API', 'Execution', 'State'],
  });
  node(N.synchronizer!, 890, 742, { kind: 'context', icon: CANTON_ICON });
  // The DVO is the pool-authority party; its hosting is deployment-specific.
  node(N.dvo!, 890, 855, { kind: 'context', icon: 'identity' });

  // Login covers both roles; only the trader signs with the external wallet.
  edge('e-keycloak', N.keycloak!, 'layer-frontend', 'login', {
    targetHandle: 'top-in', via: [{ x: 500, y: 41 }], labelAt: { x: 380, y: 41 },
  });
  edge('e-wallet', N.externalWallet!, N.trader!, 'signs', {
    labelAt: { x: 200, y: 161 },
  });
  edge('e-trader-client', N.trader!, 'layer-client', 'calls', {
    sourceHandle: 'bottom-out', via: [{ x: 370, y: 213 }, { x: 815, y: 213 }, { x: 815, y: 161 }],
    labelAt: { x: 500, y: 213 },
  });
  edge('e-operator-client', N.operator!, 'layer-client', 'calls', {
    labelAt: { x: 790, y: 161 },
  });
  edge('e-client', 'layer-client', 'layer-backend', 'HTTP + token', {
    sourceHandle: 'bottom-out', targetHandle: 'top-in',
    via: [{ x: 950, y: 266 }, { x: 680, y: 266 }], labelAt: { x: 815, y: 266 },
  });
  edge('e-routes', 'layer-backend', 'sys-workflows', 'routes', {
    sourceHandle: 'left-out', targetHandle: 'right-in',
  });
  edge('e-trigger', 'layer-backend', N.settlements!, 'manual');
  edge('e-persist', 'sys-workflows', N.stores!, 'read / write', {
    sourceHandle: 'bottom-out', targetHandle: 'top-in',
  });
  edge('e-settlement-store', N.settlements!, N.stores!, 'claim / confirm', {
    sourceHandle: 'bottom-out', targetHandle: 'right-in',
    via: [{ x: 980, y: 577 }, { x: 500, y: 577 }, { x: 500, y: 515 }], labelAt: { x: 870, y: 577 },
  });
  edge('e-db-client', N.stores!, N.dbClient!, 'queries', {
    sourceHandle: 'bottom-out', targetHandle: 'top-in',
  });
  edge('e-database', N.dbClient!, N.database!, 'SQL', {
    sourceHandle: 'left-out', targetHandle: 'right-in',
  });
  edge('e-submit', 'sys-workflows', N.adapters!, 'ledger ports', {
    sourceHandle: 'bottom-out', targetHandle: 'top-in',
    via: [{ x: 360, y: 442 }, { x: 680, y: 442 }], labelAt: { x: 505, y: 442 },
  });
  edge('e-settle', N.settlements!, N.adapters!, 'ledger operations', {
    sourceHandle: 'bottom-out', targetHandle: 'right-in', via: [{ x: 980, y: 515 }], labelAt: { x: 885, y: 515 },
  });
  edge('e-backend', N.adapters!, 'canton-runtime', 'Ledger API', {
    sourceHandle: 'bottom-out', targetHandle: 'top-in',
  });
  edge('e-hosts', 'canton-runtime', 'layer-contracts', 'executes', {
    sourceHandle: 'left-out', targetHandle: 'right-in', structural: true,
  });
  edge('e-token-standard', 'layer-contracts', N.tokenStandard!, 'uses', {
    sourceHandle: 'left-out', targetHandle: 'right-in', structural: true,
  });
  edge('e-synchronizer', 'canton-runtime', N.synchronizer!, 'connected to', {
    sourceHandle: 'out', targetHandle: 'in', structural: true,
    via: [{ x: 850, y: 836 }, { x: 850, y: 783 }], labelAt: { x: 850, y: 727 },
  });
  return graph;
}
