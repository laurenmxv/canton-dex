import { MarkerType, type Edge, type Node } from '@xyflow/react';
import type { FlowDocument, FlowStep } from './source';

export interface StepData extends Record<string, unknown> {
  label: string;
  kind: FlowStep['kind'] | 'exercise' | 'create' | 'archive' | 'check';
  number: number | null;
  offLedger: boolean;
  lane: string;
  gutterLeft: number;
  gutterRight: number;
  trackGutter: number;
}
export type StepNode = Node<StepData, 'step'> & { width: number; height: number };
export interface LaneData extends Record<string, unknown> { label: string; index: number; x: number; width: number; offLedger: boolean }
export type LaneNode = Node<LaneData, 'lane'>;
export type GroupNode = Node<{ label: string }, 'region'>;
export type FlowNode = StepNode | LaneNode | GroupNode;
type Route = 'loop' | 'bypass';
export interface WireData extends Record<string, unknown> {
  label: string;
  route?: Route;
  middleY?: number;
  branch?: number;
  /** A long decision exit: its own point on the decision, and where it runs down if it skips past a group. */
  fork?: { exitX: number; gutterX: number | null };
  source: StepNode;
  target: StepNode;
}
export type FlowEdge = Edge<WireData, 'flow'>;
export interface FlowGraph { nodes: FlowNode[]; edges: FlowEdge[]; width: number; height: number; count: number }
interface Tail { id: string; label?: string; route?: Route; branch?: number }

const CARD = 440;
const BRANCH_CARD = 380;
const TERMINAL_WIDTH = 160;
const TERMINAL_HEIGHT = 64;
const GAP = 40;
const DECISION_GAP = 80;
const TOP_PADDING = 20;
const LANE = CARD + 48;
const BRANCH_LANE = BRANCH_CARD * 2 + 88;
const TRACK_CENTER = BRANCH_CARD / 2 + 32;
const GROUP_HEADER = 128;
const GROUP_PADDING = 24;
const FORK = 100;
const FORK_TURN = 56;
/** Room beside the lanes for a branch that must pass a group spanning every lane. */
const CORRIDOR = 48;
/** A shared width keeps fit-to-width text at the same scale across flows. */
const DIAGRAM_WIDTH = LANE * 4 + CORRIDOR;
const OFF_LEDGER_LABEL = /\s*\(off-ledger\)\s*$/i;

const unmark = (value: string) => value.replaceAll('**', '');
function kindOf(step: FlowStep): StepData['kind'] {
  if (step.kind !== 'activity') return step.kind;
  if (/^Exercise /.test(step.label)) return 'exercise';
  if (/^Create /.test(step.label)) return 'create';
  if (/^Archive /.test(step.label)) return 'archive';
  if (/^(Check|Validate|Recheck|Verify)/.test(step.label)) return 'check';
  return 'activity';
}
/** Hide a choice's repeated template while retaining qualifiers and other details. */
function labelOf(step: FlowStep): string {
  const label = step.label.replace(OFF_LEDGER_LABEL, '');
  if (step.kind !== 'activity') return label;
  const lines = label.split('\n');
  const choice = /^Exercise \*\*([^*]+)\*\*$/.exec(lines[0]!);
  const target = /^on (?:(.+) )?\*\*([^*]+)\*\*$/.exec(lines[1] ?? '');
  if (!choice || !target || !choice[1]!.startsWith(`${target[2]}_`)) return label;
  return [lines[0], ...(target[1] ? [`(${target[1]})`] : []), ...lines.slice(2)].join('\n');
}
function heightOf(step: FlowStep, width: number, label: string) {
  if (['start', 'stop'].includes(step.kind)) return TERMINAL_HEIGHT;
  const lines = unmark(label).split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / ((width - 34) / 12))), 0);
  return 50 + lines * 30;
}

/** Authored swim lanes and structured steps, laid out downward. Rendered as React nodes. */
export function makeGraph(flow: FlowDocument): FlowGraph {
  const branchLanes = new Set<string>();
  function inspect(items: FlowStep[], inBranch = false) {
    for (const step of items) {
      if (inBranch) branchLanes.add(step.lane);
      if (step.kind === 'decision') {
        const splitTracks = step.branches.every(branch => branch.steps.length > 0);
        step.branches.forEach(branch => inspect(branch.steps, inBranch || splitTracks));
      }
      if (step.kind === 'loop' || step.kind === 'group') inspect(step.steps, inBranch);
    }
  }
  inspect(flow.steps);
  const laneWidths = flow.lanes.map(label => branchLanes.has(label) ? BRANCH_LANE : LANE);
  const horizontalScale = (DIAGRAM_WIDTH - CORRIDOR) / laneWidths.reduce((sum, width) => sum + width, 0);
  const horizontal = (value: number) => value * horizontalScale;
  let x = 0;
  const lanes = flow.lanes.map((label, index) => {
    const width = horizontal(laneWidths[index]!);
    const lane = { label, index, x, width, offLedger: /\boff-ledger\b/i.test(label) };
    x += width;
    return lane;
  });
  const byLane = new Map(lanes.map((lane) => [lane.label, lane]));
  const nodes: FlowNode[] = [], edges: FlowEdge[] = [];
  let count = 0;
  const nodeById = new Map<string, StepNode>();

  function put(step: FlowStep, y: number, track: number | null): StepNode {
    const lane = byLane.get(step.lane)!;
    const terminal = ['start', 'stop'].includes(step.kind);
    const width = terminal ? TERMINAL_WIDTH : horizontal(track == null ? CARD : BRANCH_CARD);
    const cx = track == null ? lane.x + lane.width / 2 : lane.x + (track === 0 ? horizontal(TRACK_CENTER) : lane.width - horizontal(TRACK_CENTER));
    const label = labelOf(step);
    const height = heightOf(step, width, label);
    const node: StepNode = { id: step.id, type: 'step', position: { x: cx - width / 2, y }, width, height,
      style: { width, height }, draggable: false, selectable: false,
      data: { ...step, label, offLedger: OFF_LEDGER_LABEL.test(step.label),
        kind: kindOf(step), number: terminal ? null : ++count, width, height, lane: lane.label,
        gutterLeft: lane.x + horizontal(12), gutterRight: lane.x + lane.width - horizontal(12),
        trackGutter: track === 0 ? lane.x + horizontal(16) : track === 1 ? lane.x + lane.width - horizontal(16) : lane.x + lane.width - horizontal(12) } };
    nodes.push(node);
    nodeById.set(node.id, node);
    return node;
  }

  function link(tails: Tail[], to: StepNode, extra: Partial<Pick<WireData, 'label' | 'route'>> = {}) {
    tails.forEach((tail) => edges.push({ id: `${tail.id}-${to.id}`, source: tail.id, target: to.id,
      type: 'flow', selectable: false, data: { source: nodeById.get(tail.id)!, target: to, label: tail.label || '', route: tail.route, branch: tail.branch, ...extra },
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: 'var(--flow-wire)' } }));
  }

  function sequence(steps: FlowStep[], startY: number, initial: Tail[] = [], track: number | null = null): { y: number; tails: Tail[] } {
    let y = startY, tails = initial;
    for (const step of steps) {
      if (step.kind === 'group') {
        const from = nodes.length;
        const result = sequence(step.steps, y + GROUP_HEADER, tails, track);
        const members = nodes.slice(from).filter((node): node is StepNode => node.type === 'step');
        if (!members.length) throw new Error(`Group ${step.label} has no visible steps.`);
        const left = Math.min(...members.map(node => node.position.x)) - horizontal(GROUP_PADDING);
        const right = Math.max(...members.map(node => node.position.x + node.width)) + horizontal(GROUP_PADDING);
        const bottom = Math.max(...members.map(node => node.position.y + node.height)) + GROUP_PADDING;
        nodes.push({ id: step.id, type: 'region', position: { x: left, y },
          width: right - left, height: bottom - y,
          style: { width: right - left, height: bottom - y, pointerEvents: 'none' },
          data: { label: step.label }, zIndex: -1, selectable: false, draggable: false });
        y = Math.max(result.y, bottom + GAP);
        tails = result.tails;
        continue;
      }
      if (step.kind === 'arrow') {
        tails = tails.map((tail) => ({ ...tail, label: step.label }));
        continue;
      }
      if (step.kind === 'detach') {
        tails = [];
        continue;
      }
      const node = put(step, y, track);
      link(tails, node);
      y += node.height + (step.kind === 'decision' ? DECISION_GAP : GAP);
      tails = [{ id: node.id }];
      if (step.kind === 'stop') tails = [];
      if (step.kind === 'decision') {
        const splitTracks = step.branches.every(branch => branch.steps.length > 0);
        const results = step.branches.map((branch, index) => sequence(branch.steps, y, [{ id: node.id, label: branch.label, branch: index }], splitTracks ? index : track));
        y = Math.max(...results.map((result) => result.y));
        tails = results.flatMap((result) => result.tails);
      }
      if (step.kind === 'loop') {
        const body = sequence(step.steps, y, [{ id: node.id, label: step.yes }], track);
        link(body.tails, node, { route: 'loop', label: 'next' });
        y = body.y + 12;
        tails = [{ id: node.id, route: 'bypass', label: step.no }];
      }
    }
    return { y, tails };
  }

  const y = sequence(flow.steps, TOP_PADDING).y + 24;
  const height = Math.max(y, 460);
  const laneNodes: LaneNode[] = lanes.map((lane) => ({ id: `lane-${lane.index}`, type: 'lane', position: { x: lane.x, y: 0 },
    style: { width: lane.width, height }, data: lane, zIndex: -2, selectable: false, draggable: false }));

  const regions = nodes.filter((node): node is GroupNode => node.type === 'region');
  const within = (node: StepNode, region: GroupNode) => node.position.x >= region.position.x
    && node.position.x + node.width <= region.position.x + region.width!
    && node.position.y >= region.position.y && node.position.y + node.height <= region.position.y + region.height!;
  for (const edge of edges) {
    const data = edge.data!;
    const { source, target } = data;
    const sy = source.position.y + source.height, ty = target.position.y;
    const long = edges.filter((other) => other.source === edge.source && other.data!.target.position.y - sy > 160);
    if (source.data.kind !== 'decision' || long.length < 2 || !long.includes(edge)) continue;
    const exitX = source.position.x + source.width / 2 + horizontal(data.branch === 0 ? -FORK : FORK);
    const entered = regions.some((region) => within(target, region) && !within(source, region));
    let gutterX: number | null = null;
    if (!entered) {
      gutterX = source.data.trackGutter;
      const passed = regions.filter((region) => region.position.y > sy && region.position.y < ty && !within(target, region));
      if (passed.some((region) => gutterX! > region.position.x && gutterX! < region.position.x + region.width!)) {
        gutterX = x + CORRIDOR / 2;
      }
    }
    data.fork = { exitX, gutterX };
  }

  for (const edge of edges) {
    const data = edge.data!;
    const { source, target } = data;
    if (data.fork) {
      edge.sourceHandle = 'bottom-out'; edge.targetHandle = 'top-in';
    } else if (data.route === 'loop') {
      edge.sourceHandle = 'right-out'; edge.targetHandle = 'right-in';
    } else if (data.route === 'bypass') {
      edge.sourceHandle = 'left-out'; edge.targetHandle = 'top-in';
    } else {
      edge.sourceHandle = 'bottom-out'; edge.targetHandle = 'top-in';
      const sy = source.position.y + source.height, ty = target.position.y;
      if (ty - sy > 0 && ty - sy <= 160) {
        const sx = source.position.x + source.width / 2, tx = target.position.x + target.width / 2;
        const obstacles = [...nodeById.values()].filter((n) => n !== source && n !== target
          && n.position.x < Math.max(sx, tx) && n.position.x + n.width > Math.min(sx, tx));
        const middle = (sy + ty) / 2;
        const candidates = [middle, ...obstacles.flatMap((n) => [n.position.y - 4, n.position.y + n.height + 4])];
        data.middleY = candidates.filter((y) => y > sy + 2 && y < ty - 2
          && !obstacles.some((n) => y > n.position.y - 2 && y < n.position.y + n.height + 2))
          .sort((a, b) => Math.abs(a-middle) - Math.abs(b-middle))[0];
      }
    }
  }
  return { nodes: [...laneNodes, ...nodes], edges, width: DIAGRAM_WIDTH, height, count };
}

/** Orthogonal routes use empty row gaps and lane gutters for long skips and loops. */
export function edgeGeometry(data: WireData) {
  const s = data.source, t = data.target;
  let sx = s.position.x + s.width / 2, sy = s.position.y + s.height;
  const tx = t.position.x + t.width / 2, ty = t.position.y;
  let points: [number, number][], label: [number, number];
  if (data.fork) {
    const { exitX, gutterX } = data.fork;
    points = gutterX == null
      ? [[exitX,sy], [exitX,ty-24], [tx,ty-24], [tx,ty]]
      : [[exitX,sy], [exitX,sy+FORK_TURN], [gutterX,sy+FORK_TURN], [gutterX,ty-22], [tx,ty-22], [tx,ty]];
    return { labelAtTarget: false, points, path: points.map(([x,y], i) => `${i ? 'L' : 'M'} ${x} ${y}`).join(' '), label: [exitX, sy + 26] as [number, number] };
  }
  if (data.route === 'loop') {
    sx = s.position.x + s.width; sy = s.position.y + s.height / 2;
    const x = Math.max(s.data.gutterRight, t.data.gutterRight);
    const endY = t.position.y + t.height / 2;
    points = [[sx,sy], [x,sy], [x,endY], [t.position.x+t.width,endY]];
    label = [x, (sy + endY) / 2];
  } else if (data.route === 'bypass') {
    sx = s.position.x; sy = s.position.y + s.height / 2;
    const x = Math.min(s.data.gutterLeft, t.data.gutterLeft);
    points = [[sx,sy], [x,sy], [x,ty-22], [tx,ty-22], [tx,ty]];
    label = [x, s.position.y + s.height + 20];
  } else if (ty - sy > 160) {
    const x = s.data.trackGutter;
    const approachY = ty - (s.data.kind === 'decision' ? 40 : 22);
    points = [[sx,sy], [sx,sy+20], [x,sy+20], [x,approachY], [tx,approachY], [tx,ty]];
    label = [sx,sy+20];
  } else {
    const middle = data.middleY ?? sy + (ty-sy)/2;
    points = [[sx,sy], [sx,middle], [tx,middle], [tx,ty]];
    label = [Math.abs(tx-sx)>80 ? (sx+tx)/2 : sx, middle];
  }
  const labelAtTarget = s.data.kind === 'decision' && !!data.label;
  if (labelAtTarget) label = [tx, (points.at(-2)![1] + ty) / 2];
  return { labelAtTarget, points, path: points.map(([x,y], i) => `${i ? 'L' : 'M'} ${x} ${y}`).join(' '), label };
}
