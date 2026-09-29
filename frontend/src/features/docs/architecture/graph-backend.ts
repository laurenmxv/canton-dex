import type { Edge } from '@xyflow/react';
import { model, type DiagramEdgeData } from './content';
import { canvas, type Graph } from './graph-base';
import { PARTICIPANT, backendGraph } from './graph-layers';

const N = model.N;
export const BUSINESS_GROUP = 'backend-business';
export const SETTLEMENT_GROUP = 'backend-settlements';
export const NETWORK = 'backend-canton-network';
const business = [N.onboarding!, N.pools!, N.swaps!, N.liquidity!, N.tokens!];

type Pair = [number, number];
const positions: Record<string, Pair> = {
  'context-client': [160, 20], [N.api!]: [160, 200], [N.iam!]: [160, 330], [N.activity!]: [160, 470],
  [N.application!]: [160, 620], [N.platform!]: [160, 760],
  [N.onboarding!]: [520, 230], [N.pools!]: [520, 320], [N.swaps!]: [520, 410], [N.liquidity!]: [520, 500],
  [N.tokens!]: [520, 590],
  [N.adapters!]: [880, 200], [N.operations!]: [880, 420], [N.stores!]: [880, 620], [N.dbClient!]: [1140, 620],
  [N.settlements!]: [470, 830], [N.settlementDecision!]: [750, 830], [N.settlementQueues!]: [1030, 830],
  [N.settlementAutomation!]: [750, 960],
  [N.ledgerApi!]: [1500, 200], [N.dvo!]: [1460, 340], [N.synchronizer!]: [1540, 470], [N.database!]: [1500, 620],
};
/** Boundaries as x, y, width and height. The Backend and the participant are semantic; the rest only group. */
const boundaries: Record<string, [number, number, number, number]> = {
  'backend-boundary': [0, 130, 1370, 990],
  [BUSINESS_GROUP]: [470, 190, 280, 510],
  [SETTLEMENT_GROUP]: [440, 780, 800, 280],
  [NETWORK]: [1430, 100, 340, 480],
  [PARTICIPANT]: [1450, 145, 300, 145],
};
const groups: [string, string][] = [
  [BUSINESS_GROUP, 'Business modules'], [SETTLEMENT_GROUP, 'Settlements'], [NETWORK, 'Canton network'],
];

/** Hand-drawn wires: handles, then the points as x,y pairs, then the label point. */
const routes: Record<string, [string, string, number[], Pair]> = {
  'backend-client': ['bottom-out', 'top-in', [250, 84, 250, 200], [250, 165]],
  'backend-authenticate': ['bottom-out', 'top-in', [250, 264, 250, 330], [250, 297]],
  'backend-compose-router': ['left-out', 'in', [160, 652, 95, 652, 95, 232, 160, 232], [95, 560]],
  'backend-platform': ['bottom-out', 'top-in', [250, 684, 250, 760], [250, 722]],
  'backend-routes-business': ['out', 'in', [340, 214, 470, 214], [405, 214]],
  'backend-route-settlement': ['out', 'top-in', [340, 238, 420, 238, 420, 740, 840, 740, 840, 830], [420, 470]],
  'backend-activity-route': ['out', 'right-in', [340, 254, 375, 254, 375, 502, 340, 502], [375, 420]],
  'backend-activity-history': ['out', 'bottom-in', [340, 518, 385, 518, 385, 764, 920, 764, 920, 684], [620, 764]],
  'backend-accounts-sql': ['left-out', 'bottom-in', [160, 362, 25, 362, 25, 1100, 1290, 1100, 1290, 684], [700, 1100]],
  'backend-ledger-business': ['out', 'in', [750, 222, 880, 222], [815, 222]],
  'backend-persist-business': ['out', 'in', [750, 652, 880, 652], [815, 652]],
  'backend-settlement-plan': ['left-out', 'right-in', [750, 862, 650, 862], [700, 862]],
  'backend-settlement-queue': ['left-out', 'right-in', [1030, 862, 930, 862], [980, 862]],
  'backend-settlement-automatic': ['top-out', 'bottom-in', [840, 960, 840, 894], [840, 927]],
  'backend-settlement-recovery': ['left-out', 'bottom-in', [750, 992, 560, 992, 560, 894], [655, 992]],
  'backend-settlement-progress': ['bottom-out', 'bottom-in', [500, 894, 500, 1040, 1150, 1040, 1150, 894], [1000, 1040]],
  [`backend-ledger-${N.settlements}`]: ['bottom-out', 'right-in',
    [480, 894, 480, 1078, 1350, 1078, 1350, 248, 1060, 248], [900, 1078]],
  'backend-shared-requests': ['bottom-out', 'top-in', [1045, 684, 1045, 830], [1045, 757]],
  'backend-queue-queries': ['out', 'bottom-in', [1210, 862, 1260, 862, 1260, 684], [1260, 730]],
  'backend-command-journal': ['bottom-out', 'top-in', [970, 264, 970, 420], [970, 342]],
  'backend-queue-helpers': ['top-out', 'bottom-in', [970, 620, 970, 484], [970, 552]],
  'backend-command-sql': ['out', 'top-in', [1060, 452, 1230, 452, 1230, 620], [1230, 536]],
  'backend-store-queries': ['out', 'in', [1060, 652, 1140, 652], [1100, 652]],
  'backend-sql': ['out', 'in', [1320, 652, 1500, 652], [1420, 652]],
  'backend-ledger-api': ['out', 'in', [1060, 216, 1500, 216], [1280, 216]],
  'backend-synchronizer': ['bottom-out', 'top-in', [1700, 290, 1700, 470], [1700, 380]],
};

type DiagramEdge = Edge<DiagramEdgeData>;
/** Relations every business module has in common, drawn once to the group's border. */
const aggregates = [
  { id: 'backend-routes-business', source: N.api!, target: BUSINESS_GROUP, label: 'routes', summary: 'Routes to',
    member: (edge: DiagramEdge) => edge.source === N.api && business.includes(edge.target) },
  { id: 'backend-ledger-business', source: BUSINESS_GROUP, target: N.adapters!, label: 'ledger ports', summary: 'Ledger ports from',
    member: (edge: DiagramEdge) => business.includes(edge.source) && edge.target === N.adapters },
  { id: 'backend-persist-business', source: BUSINESS_GROUP, target: N.stores!, label: 'records', summary: 'Records from',
    member: (edge: DiagramEdge) => business.includes(edge.source) && edge.target === N.stores },
];

/** Hover text for a relation whose label alone could mislead. */
const summaries: Record<string, string> = {
  'backend-shared-requests': 'Request queues read and update the swap and liquidity request rows that Swaps and Liquidity '
    + 'admit into Domain stores. The rows are shared, not copied, and no broker is called.',
};

const list = (names: string[]) => `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/**
 * The Backend as drawn: every component of `backendGraph()` on a hand-drawn layout, with the
 * relations the five business modules share drawn once to a presentation-only group.
 */
export function backendDisplayGraph(): Graph {
  const semantic = backendGraph();
  const labels = new Map(semantic.nodes.map((node) => [node.id, node.data.label]));
  const drawn = canvas(0, 0);
  for (const [id, label] of groups) {
    const [x, y, width, height] = boundaries[id]!;
    drawn.node(id, x, y, { kind: 'boundary', label, width, height });
  }
  const shaped = (node: Graph['nodes'][number]) => {
    const box = boundaries[node.id];
    if (box) return { ...node, position: { x: box[0], y: box[1] }, width: box[2], height: box[3] };
    const at = positions[node.id];
    if (!at) throw new Error(`No backend position for ${node.id}`);
    return { ...node, position: { x: at[0], y: at[1] } };
  };
  // Outer boundaries first, so each nested group and every card draws above the one around it.
  const order = ['backend-boundary', NETWORK, PARTICIPANT, BUSINESS_GROUP, SETTLEMENT_GROUP];
  const all = [...semantic.nodes.map(shaped), ...drawn.graph.nodes];
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  const nodes = all.sort((a, b) => rank(a.id) - rank(b.id));

  const grouped = new Set<string>();
  const merged: DiagramEdge[] = aggregates.map(({ id, source, target, label, summary, member }) => {
    const members = semantic.edges.filter(member);
    if (members.length !== business.length) throw new Error(`${id} groups ${members.length} relations`);
    for (const edge of members) grouped.add(edge.id);
    const modules = members.map((edge) => labels.get(business.includes(edge.source) ? edge.source : edge.target)!);
    return {
      ...members[0]!, id, source, target, label,
      data: { structural: false, members: members.map((edge) => edge.id), summary: `${summary} ${list(modules)}: ${members.length} relations` },
    };
  });
  const kept = semantic.edges.filter((edge) => !grouped.has(edge.id))
    .map((edge) => ({ ...edge, data: { structural: edge.data?.structural ?? false, summary: summaries[edge.id] } }));

  const edges = [...kept, ...merged].map((edge) => {
    const route = routes[edge.id];
    if (!route) throw new Error(`No backend route for ${edge.id}`);
    const [sourceHandle, targetHandle, flat, [x, y]] = route;
    const points = flat.flatMap((value, index) => index % 2 ? [] : [{ x: value, y: flat[index + 1]! }]);
    return { ...edge, sourceHandle, targetHandle, data: { ...edge.data, route: { points, label: { x, y } } } };
  });
  if (edges.length !== Object.keys(routes).length) throw new Error('Unused backend routes');
  return { nodes, edges, width: 1790, height: 1130, authored: true };
}
