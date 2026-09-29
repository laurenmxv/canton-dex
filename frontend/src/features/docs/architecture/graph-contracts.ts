import { model } from './content';
import { canvas, type Graph } from './graph-base';

const N = model.N;
const C = model.C;

type Pair = [number, number];
const port = (id: string, end: 'in' | 'out') => `choice-${id}-${end}`;

/** Groups as id, caption, x, y, width and height. They only group; they have no relations of their own. */
const groups: [string, string, number, number, number, number][] = [
  ['contracts-creation-region', 'Pool creation', 690, 0, 660, 250],
  ['contracts-access-region', 'Access', 390, 420, 280, 410],
  ['contracts-authority-region', 'Settlement authority', 800, 420, 300, 280],
  ['contracts-engine-region', 'Pool engine', 1180, 370, 620, 320],
  ['contracts-outcomes-region', 'Outcomes', 1500, 710, 300, 220],
];
const templates: [string, number, number][] = [
  [N.proposal!, 720, 50], [N.factory!, 1060, 50], [N.kyc!, 410, 470], [N.access!, 410, 590],
  [N.delegation!, 830, 470], [N.pool!, 1220, 470], [N.config!, 1530, 460], [N.state!, 1530, 590],
  [N.swapReceipt!, 1530, 750], [N.liquidityReceipt!, 1530, 840],
];

/**
 * Hand-drawn wires: the relation, its handles, the points as x,y pairs and the label point.
 * Only a choice-specific relation ends on a choice row; the others use a template's heading,
 * top or bottom, so they never read as one choice.
 */
const wires: [string, string, string, string, string, string, number[], Pair][] = [
  // Onboarding creates access without invoking any of its business choices.
  ['grant-kyc', N.ledgerApi!, N.kyc!, 'create', 'out', 'in', [280, 504, 410, 504], [335, 504]],
  ['grant-access', N.ledgerApi!, N.access!, 'create', 'bottom-out', 'in', [170, 552, 170, 610, 410, 610], [300, 610]],
  // ProposePool creates the proposal; its acceptance calls CreatePool in the same ledger transaction.
  ['factory-proposal', N.factory!, N.proposal!, 'propose', port(C.propose!, 'out'), 'top-in',
    [1300, 124, 1320, 124, 1320, 20, 840, 20, 840, 50], [1010, 20]],
  ['proposal-accept', N.proposal!, N.factory!, 'accept', port(C.accept!, 'out'), port(C.create!, 'in'),
    [960, 124, 1010, 124, 1010, 156, 1060, 156], [1010, 140]],
  // The DVO accepts on its Accept row; Reject keeps its own controller in the row's tip.
  ['dvo-accept', N.dvo!, N.proposal!, 'accept', 'out', port(C.accept!, 'in'), [280, 124, 720, 124], [500, 124]],
  ['dvo-grant', N.dvo!, N.delegation!, 'grant', 'bottom-out', 'top-in', [240, 142, 240, 270, 1020, 270, 1020, 470], [790, 270]],
  ['factory-pool', N.factory!, N.pool!, 'create', port(C.create!, 'out'), 'top-in', [1300, 156, 1380, 156, 1380, 470], [1380, 320]],
  // Token validation takes the outer lane, clear of the pool engine.
  ['factory-token-standard', N.factory!, N.tokenStandard!, 'check factories', port(C.create!, 'out'), 'right-in',
    [1300, 156, 1840, 156, 1840, 950, 1160, 950], [1590, 156]],
  ['access-kyc', N.access!, N.kyc!, 'check KYC', 'top-out', 'bottom-in', [530, 590, 530, 538], [530, 564]],
  ['access-tokens', N.access!, N.tokenStandard!, 'allocate', 'bottom-out', 'in', [530, 786, 530, 921, 920, 921], [720, 921]],
  // A durable off-ledger handoff separates requests from settlement. There is
  // deliberately no synchronous PoolAccess → VenueDelegation connector.
  // One settle relation stands for all three settlement choices, and reading the config is not its
  // Change fee choice, so these wires join the headings.
  ['permission-pool', N.delegation!, N.pool!, 'settle', 'out', 'in', [1070, 500, 1220, 500], [1140, 500]],
  ['pool-config', N.pool!, N.config!, 'read', 'out', 'in', [1460, 484, 1530, 484], [1495, 484]],
  ['pool-state', N.pool!, N.state!, 'replace', 'out', 'in', [1460, 506, 1500, 506, 1500, 624, 1530, 624], [1500, 580]],
  ['pool-swap-result', N.pool!, N.swapReceipt!, 'create', 'bottom-out', 'in', [1400, 634, 1400, 784, 1530, 784], [1465, 784]],
  ['pool-liquidity-result', N.pool!, N.liquidityReceipt!, 'create', 'bottom-out', 'in', [1360, 634, 1360, 874, 1530, 874], [1445, 874]],
  ['delegation-access', N.delegation!, N.access!, 'check access', 'bottom-out', 'bottom-in',
    [880, 666, 880, 806, 600, 806, 600, 786], [760, 806]],
  ['delegation-kyc', N.delegation!, N.kyc!, 'check KYC', 'left-out', 'right-in', [830, 500, 650, 500], [740, 500]],
  ['pool-tokens', N.pool!, N.tokenStandard!, 'settle allocations', 'bottom-out', 'right-in', [1260, 634, 1260, 921, 1160, 921], [1260, 780]],
];

/**
 * Positions describe the source-reviewed responsibilities, not execution order. The wires are
 * authored, so each relation keeps one readable path with no bridge arcs.
 */
export function contractsGraph(): Graph {
  const { graph, node, edge } = canvas(1880, 990);
  for (const [id, label, x, y, width, height] of groups) node(id, x, y, { kind: 'boundary', label, width, height });
  for (const [id, x, y] of templates) node(id, x, y, { kind: 'template', label: model.nodes[id]!.exact });
  // Context outside the DEX templates takes the leftmost column and the amber palette here.
  node(N.dvo!, 60, 60, { kind: 'context', icon: 'identity', amber: true });
  node(N.ledgerApi!, 60, 470, { kind: 'context', layerId: 'canton', amber: true });
  node(N.tokenStandard!, 920, 880, { kind: 'context', width: 240, chips: ['Holdings', 'Allocations'] });

  for (const [id, source, target, label, sourceHandle, targetHandle, flat, [x, y]] of wires) {
    edge(id, source, target, label, { sourceHandle, targetHandle });
    const points = flat.flatMap((value, index) => (index % 2 ? [] : [{ x: value, y: flat[index + 1]! }]));
    const drawn = graph.edges[graph.edges.length - 1]!;
    drawn.data = { ...drawn.data, route: { points, label: { x, y } } };
  }
  return { ...graph, authored: true };
}
