import type { Edge } from '@xyflow/react';
import type { Node } from '@xyflow/react';
import type { DiagramEdgeData, DiagramNodeData } from './content';
import { BAND_CAPTION, BAND_CLASS, CAPTION, CHOICE_HEIGHT, TITLE_HEIGHT, choiceRowCenter } from './graph-base';
import { buildGraph } from './graph';

/**
 * Global wire routing with libavoid (Adaptagrams), which the Atlas loads as WebAssembly.
 *
 * Boxes keep their authored positions. Each view is routed once, from its complete structure,
 * so the same map always shows the same wires. Bands and containers group boxes; wires pass
 * through them.
 */

export interface Point { x: number; y: number }
export interface Route { points: Point[]; label: Point }
export interface Bounds { x: number; y: number; width: number; height: number }
export interface RouteTable { routes: ReadonlyMap<string, Route>; bounds: Bounds }

/** The subset of the libavoid-js embind API the Atlas uses, as the runtime exposes it. */
interface AvoidEnum { value: number }
interface AvoidObject { delete(): void }
interface AvoidPoint extends AvoidObject { x: number; y: number }
interface AvoidPolyLine extends AvoidObject { size(): number; at(index: number): AvoidPoint }
interface AvoidRouter extends AvoidObject {
  setRoutingParameter(parameter: AvoidEnum, value: number): void;
  setRoutingOption(option: AvoidEnum, value: boolean): void;
  processTransaction(): void;
}
interface AvoidShape extends AvoidObject { polygon(): unknown }
interface AvoidPin extends AvoidObject { setExclusive(exclusive: boolean): void }
type AvoidConnEnd = AvoidObject;
interface AvoidConnector extends AvoidObject { displayRoute(): AvoidPolyLine }
export interface AvoidApi {
  RouterFlag: { OrthogonalRouting: AvoidEnum };
  RoutingParameter: Record<'segmentPenalty' | 'fixedSharedPathPenalty' | 'shapeBufferDistance' | 'idealNudgingDistance', AvoidEnum>;
  RoutingOption: Record<'nudgeOrthogonalSegmentsConnectedToShapes' | 'nudgeSharedPathsWithCommonEndPoint' | 'penaliseOrthogonalSharedPathsAtConnEnds', AvoidEnum>;
  Router: new (flags: number) => AvoidRouter;
  Point: new (x: number, y: number) => AvoidPoint;
  Rectangle: new (topLeft: AvoidPoint, bottomRight: AvoidPoint) => AvoidObject;
  ShapeRef: new (router: AvoidRouter, polygon: AvoidObject) => AvoidShape;
  ShapeConnectionPin: new (shape: AvoidShape, classId: number, x: number, y: number,
    proportional: boolean, insideOffset: number, directions: number) => AvoidPin;
  ConnEnd: { new (shape: AvoidShape, classId: number): AvoidConnEnd; new (point: AvoidPoint): AvoidConnEnd };
  ConnRef: new (router: AvoidRouter, source: AvoidConnEnd, target: AvoidConnEnd) => AvoidConnector;
}

type Side = 'left' | 'right' | 'top' | 'bottom';
/** `text` covers the box's visible words: its title, choice rows and chips. Labels never cover them. */
interface Box { x: number; y: number; width: number; height: number; obstacle: boolean; choices: string[]; text: Rect[] }
/** `at` fixes the offset along the side, as a choice row does; free ends are spread by the router. */
interface WireEnd { node: string; side: Side; at: number | null }
interface Wire { key: string; source: WireEnd; target: WireEnd; label: string }
export interface Structure {
  boxes: ReadonlyMap<string, Box>;
  wires: readonly Wire[];
}

const SIDES: Record<string, Side> = {
  in: 'left', 'left-out': 'left', out: 'right', 'right-in': 'right',
  'top-in': 'top', 'top-out': 'top', 'bottom-in': 'bottom', 'bottom-out': 'bottom',
};
/** libavoid ConnDirFlags (connend.h): the direction a wire may leave a pin. */
const LEAVES: Record<Side, number> = { top: 1, bottom: 2, left: 4, right: 8 };
const SHAPE_BUFFER = 12;
/** A group's caption blocks wires only this far beyond its words; the rest of the group stays open. */
const CAPTION_CLEARANCE = 2;
const PIN_SPACING = 12;
const PIN_MARGIN = 10;
const LABEL_HEIGHT = 19;
const HOP_RADIUS = 5;
/** Around an end point two wires share, they meet by design, so crossings there never hop. */
const JUNCTION_RADIUS = 36;

type RoutedEdge = Pick<Edge<DiagramEdgeData>, 'id' | 'source' | 'target' | 'sourceHandle' | 'targetHandle'>;

/** One wire variant: the same relationship attached to another port is another route. */
export function routeKey(edge: RoutedEdge): string {
  return [edge.id, edge.source, edge.sourceHandle ?? 'out', edge.target, edge.targetHandle ?? 'in'].join('|');
}

function sideCenter(box: Box, side: Side): Point {
  if (side === 'left') return { x: box.x, y: box.y + box.height / 2 };
  if (side === 'right') return { x: box.x + box.width, y: box.y + box.height / 2 };
  if (side === 'top') return { x: box.x + box.width / 2, y: box.y };
  return { x: box.x + box.width / 2, y: box.y + box.height };
}

/** Approximate text extents from the node styles (16px titles after a glyph, 12px chips and choice rows). */
function textOf(node: Node<DiagramNodeData>): Rect[] {
  const { x, y } = node.position;
  const width = node.width!;
  const height = node.height!;
  const { label, kind, chips, choices } = node.data;
  if (kind === 'boundary') {
    const caption = node.className === BAND_CLASS ? BAND_CAPTION : CAPTION;
    return [{ x1: x + 16, y1: y + 10, x2: x + 16 + label.length * caption.charWidth, y2: y + caption.bottom }];
  }
  const room = width - 44;
  const lines = Math.max(1, Math.ceil((label.length * 9.5) / room));
  const text: Rect[] = [{
    x1: x + 10, y1: y + TITLE_HEIGHT / 2 - lines * 10 - 2,
    x2: x + 44 + Math.min(room, label.length * 9.5), y2: y + TITLE_HEIGHT / 2 + lines * 10 + 2,
  }];
  if (choices?.length) text.push({ x1: x, y1: y + TITLE_HEIGHT, x2: x + width, y2: y + TITLE_HEIGHT + CHOICE_HEIGHT * choices.length });
  if (chips?.length) {
    const words = 28 + chips.reduce((sum, chip) => sum + chip.length * 7, 0) + 8 * (chips.length - 1);
    text.push({ x1: x, y1: y + TITLE_HEIGHT, x2: x + Math.min(width, words), y2: y + height });
  }
  return text;
}

/** The structure of `view`: every box and wire it renders. */
export function structureOf(view: string): Structure {
  const graph = buildGraph(view);
  const boxes = new Map<string, Box>();
  for (const node of graph.nodes) {
    boxes.set(node.id, {
      x: node.position.x, y: node.position.y, width: node.width!, height: node.height!,
      obstacle: node.data.kind !== 'boundary' && node.zIndex !== -1,
      choices: node.data.choices?.map((choice) => choice.id) ?? [],
      text: textOf(node),
    });
  }
  const end = (node: string, handle: string): WireEnd => {
    const choice = /^choice-(.+)-(in|out)$/.exec(handle);
    if (!choice) return { node, side: SIDES[handle] ?? 'right', at: null };
    return { node, side: choice[2] === 'in' ? 'left' : 'right', at: choiceRowCenter(boxes.get(node)!.choices.indexOf(choice[1]!)) };
  };
  const wires = graph.edges.map((edge) => ({
    key: routeKey(edge), label: typeof edge.label === 'string' ? edge.label : '',
    source: end(edge.source, edge.sourceHandle!), target: end(edge.target, edge.targetHandle!),
  }));
  return { boxes, wires: wires.sort((a, b) => a.key.localeCompare(b.key)) };
}

interface Pin { x: number; y: number; side: Side; group: string; shared: boolean }

/**
 * Ends that meet one side are spread along it, ordered by where their other end lies, so
 * neighbouring wires leave in the order they travel. A side too short for its ends keeps one
 * shared port, which the router fans out after the first segment.
 */
function assignPins(structure: Structure): Map<string, Pin> {
  const pins = new Map<string, Pin>();
  const groups = new Map<string, { id: string; end: WireEnd; toward: number }[]>();
  const centerOf = (end: WireEnd) => {
    const box = structure.boxes.get(end.node)!;
    return end.at === null ? { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      : { x: end.side === 'left' ? box.x : box.x + box.width, y: box.y + end.at };
  };
  for (const wire of structure.wires) {
    for (const [role, end, other] of [['s', wire.source, wire.target], ['t', wire.target, wire.source]] as const) {
      const id = `${wire.key}#${role}`;
      const box = structure.boxes.get(end.node)!;
      if (end.at !== null) {
        const x = end.side === 'left' ? box.x : box.x + box.width;
        pins.set(id, { x, y: box.y + end.at, side: end.side, group: `${end.node}@${end.at}${end.side}`, shared: false });
        continue;
      }
      const target = centerOf(other);
      const group = `${end.node}:${end.side}`;
      const list = groups.get(group) ?? [];
      list.push({ id, end, toward: end.side === 'left' || end.side === 'right' ? target.y : target.x });
      groups.set(group, list);
    }
  }
  for (const [group, list] of groups) {
    list.sort((a, b) => a.toward - b.toward || a.id.localeCompare(b.id));
    const { end } = list[0]!;
    const box = structure.boxes.get(end.node)!;
    const center = sideCenter(box, end.side);
    const along = end.side === 'left' || end.side === 'right' ? box.height : box.width;
    const spread = list.length > 1 && (list.length - 1) * PIN_SPACING <= along - 2 * PIN_MARGIN;
    list.forEach(({ id }, index) => {
      const offset = spread ? (index - (list.length - 1) / 2) * PIN_SPACING : 0;
      const vertical = end.side === 'left' || end.side === 'right';
      pins.set(id, {
        x: center.x + (vertical ? 0 : offset), y: center.y + (vertical ? offset : 0), side: end.side,
        group: spread ? id : group, shared: !spread && list.length > 1,
      });
    });
  }
  // A free port whose straight approach would cross a caption slides along its side, just clear of
  // the words. Choice-row ports stay exact.
  const captions = [...structure.boxes.values()].flatMap((box) => captionOf(box) ?? []);
  const reach = SHAPE_BUFFER + 4;
  const blocked = (pin: Pin) => {
    const out = { top: [0, -reach], bottom: [0, reach], left: [-reach, 0], right: [reach, 0] }[pin.side];
    const x1 = Math.min(pin.x, pin.x + out[0]!); const x2 = Math.max(pin.x, pin.x + out[0]!);
    const y1 = Math.min(pin.y, pin.y + out[1]!); const y2 = Math.max(pin.y, pin.y + out[1]!);
    return captions.some((c) => x1 < c.x2 + CAPTION_CLEARANCE && x2 > c.x1 - CAPTION_CLEARANCE
      && y1 < c.y2 + CAPTION_CLEARANCE && y2 > c.y1 - CAPTION_CLEARANCE);
  };
  for (const wire of structure.wires) {
    for (const [role, end] of [['s', wire.source], ['t', wire.target]] as const) {
      const pin = pins.get(`${wire.key}#${role}`)!;
      if (end.at !== null || !blocked(pin)) continue;
      const box = structure.boxes.get(end.node)!;
      const vertical = pin.side === 'left' || pin.side === 'right';
      const [low, high] = vertical ? [box.y + PIN_MARGIN, box.y + box.height - PIN_MARGIN] : [box.x + PIN_MARGIN, box.x + box.width - PIN_MARGIN];
      const edges = captions.flatMap((c) => (vertical ? [c.y1, c.y2] : [c.x1, c.x2]))
        .flatMap((edge) => [edge - CAPTION_CLEARANCE - 4, edge + CAPTION_CLEARANCE + 4]);
      const origin = vertical ? pin.y : pin.x;
      const clear = edges.filter((at) => at >= low && at <= high)
        .map((at) => ({ ...pin, [vertical ? 'y' : 'x']: at }))
        .filter((moved) => !blocked(moved))
        .sort((a, b) => Math.abs((vertical ? a.y : a.x) - origin) - Math.abs((vertical ? b.y : b.x) - origin));
      if (clear[0]) pins.set(`${wire.key}#${role}`, { ...clear[0], group: `${pin.group}@caption` });
    }
  }
  // Two choice-row ends at one port share it too.
  const counts = new Map<string, number>();
  for (const pin of pins.values()) counts.set(pin.group, (counts.get(pin.group) ?? 0) + 1);
  for (const pin of pins.values()) if ((counts.get(pin.group) ?? 0) > 1) pin.shared = true;
  return pins;
}

function simplify(points: Point[]): Point[] {
  const rounded = points.map(({ x, y }) => ({ x: Math.round(x), y: Math.round(y) }));
  const out: Point[] = [];
  for (const point of rounded) {
    const last = out[out.length - 1];
    if (last && last.x === point.x && last.y === point.y) continue;
    const before = out[out.length - 2];
    if (before && last && ((before.x === last.x && last.x === point.x) || (before.y === last.y && last.y === point.y))) out.pop();
    out.push(point);
  }
  return out;
}

interface Rect { x1: number; y1: number; x2: number; y2: number }
const overlaps = (a: Rect, b: Rect) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
const overlapArea = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1))
  * Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
const segmentHits = (rect: Rect, a: Point, b: Point) => overlaps(rect, {
  x1: Math.min(a.x, b.x) - 0.5, y1: Math.min(a.y, b.y) - 0.5, x2: Math.max(a.x, b.x) + 0.5, y2: Math.max(a.y, b.y) + 0.5,
});
export const labelWidth = (text: string) => Math.ceil(text.length * 7) + 10;

/** Where a label may sit along one segment: on it, beside it, or just past either end. */
function labelSpots(a: Point, b: Point, width: number): { point: Point; cost: number }[] {
  const horizontal = a.y === b.y;
  const length = Math.abs(horizontal ? b.x - a.x : b.y - a.y);
  const along = (t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const spots: { point: Point; cost: number }[] = [];
  if (length >= (horizontal ? width : LABEL_HEIGHT) + 4) {
    for (const t of [0.5, 0.3, 0.7, 0.15, 0.85]) spots.push({ point: along(t), cost: Math.abs(t - 0.5) * 10 + (horizontal ? 0 : 3) });
  }
  const aside = horizontal ? LABEL_HEIGHT / 2 + 3 : width / 2 + 3;
  for (const t of [0.5, 0.15, 0.85]) {
    const at = along(t);
    for (const sign of [-1, 1]) {
      spots.push({ point: horizontal ? { x: at.x, y: at.y + sign * aside } : { x: at.x + sign * aside, y: at.y }, cost: 8 + Math.abs(t - 0.5) * 10 });
    }
  }
  const further = horizontal ? aside + LABEL_HEIGHT + 2 : aside + 12;
  for (const sign of [-1, 1]) {
    const at = along(0.5);
    spots.push({ point: horizontal ? { x: at.x, y: at.y + sign * further } : { x: at.x + sign * further, y: at.y }, cost: 16 });
  }
  const beyond = horizontal ? width / 2 + 4 : LABEL_HEIGHT / 2 + 4;
  for (const [end, from] of [[a, b], [b, a]] as const) {
    const sign = horizontal ? Math.sign(end.x - from.x) : Math.sign(end.y - from.y);
    spots.push({ point: horizontal ? { x: end.x + sign * beyond, y: end.y } : { x: end.x, y: end.y + sign * beyond }, cost: 12 });
  }
  return spots;
}

/** The caption of a band or container: its first text line, the only part of it wires avoid. */
export function captionOf(box: Box): Rect | null {
  return box.obstacle ? null : box.text[0] ?? null;
}

const LANE_CLEARANCE = 6;
const LANE_STEPS = [10, -10, 20, -20, 30, -30, 40, -40];
const MIN_SEGMENT = 6;

/** Length two axis-aligned segments share on one line; 0 unless they are collinear. */
function sharedLength(a1: Point, a2: Point, b1: Point, b2: Point): number {
  const horizontal = a1.y === a2.y && b1.y === b2.y && a1.y === b1.y;
  const vertical = a1.x === a2.x && b1.x === b2.x && a1.x === b1.x;
  if (!horizontal && !vertical) return 0;
  const axis = horizontal ? 'x' : 'y';
  return Math.min(Math.max(a1[axis], a2[axis]), Math.max(b1[axis], b2[axis]))
    - Math.max(Math.min(a1[axis], a2[axis]), Math.min(b1[axis], b2[axis]));
}

/** Moves the middle segment `index` sideways by `offset`, or null if a neighbour would reverse or vanish. */
function shiftSegment(points: readonly Point[], index: number, offset: number): Point[] | null {
  const axis = points[index]!.y === points[index + 1]!.y ? 'y' : 'x';
  const moved = points.map((point, at) => (at === index || at === index + 1 ? { ...point, [axis]: point[axis] + offset } : point));
  for (const [from, to] of [[index - 1, index], [index + 1, index + 2]] as const) {
    const before = points[to]![axis] - points[from]![axis];
    const after = moved[to]![axis] - moved[from]![axis];
    if (Math.sign(before) !== Math.sign(after) || Math.abs(after) < MIN_SEGMENT) return null;
  }
  return moved;
}

/**
 * libavoid can leave two wires on one channel, where they read
 * as one. The later wire moves its shared middle segment to the nearest free parallel lane that
 * clears every box and every wire shown with it. End segments never move, so ports stay exact.
 * The pass runs once per view, so the map is the same on every visit.
 */
function separateLanes(structure: Structure, routes: Map<string, Point[]>): void {
  const wires = new Map(structure.wires.map((wire) => [wire.key, wire]));
  const keys = [...wires.keys()];
  const boxes = [...structure.boxes].filter(([, box]) => box.obstacle);
  const captions = [...structure.boxes.values()].flatMap((box) => captionOf(box) ?? []);
  const unrelated = (a: string, b: string, pa: Point[], pb: Point[]) => a !== b && sharedEnds(pa, pb).length === 0;
  const clears = (key: string, points: Point[]) => {
    const wire = wires.get(key)!;
    for (let index = 1; index < points.length; index++) {
      const a = points[index - 1]!; const b = points[index]!;
      const terminal = index === 1 || index === points.length - 1;
      for (const [id, box] of boxes) {
        const own = terminal && (id === wire.source.node || id === wire.target.node);
        const pad = own ? -1 : LANE_CLEARANCE;
        if (Math.min(a.x, b.x) < box.x + box.width + pad && Math.max(a.x, b.x) > box.x - pad
          && Math.min(a.y, b.y) < box.y + box.height + pad && Math.max(a.y, b.y) > box.y - pad) return false;
      }
      for (const caption of captions) {
        if (Math.min(a.x, b.x) < caption.x2 + CAPTION_CLEARANCE && Math.max(a.x, b.x) > caption.x1 - CAPTION_CLEARANCE
          && Math.min(a.y, b.y) < caption.y2 + CAPTION_CLEARANCE && Math.max(a.y, b.y) > caption.y1 - CAPTION_CLEARANCE) return false;
      }
    }
    for (const other of keys) {
      const theirs = routes.get(other)!;
      if (!unrelated(key, other, points, theirs)) continue;
      for (let i = 1; i < points.length; i++) {
        for (let j = 1; j < theirs.length; j++) if (sharedLength(points[i - 1]!, points[i]!, theirs[j - 1]!, theirs[j]!) > 1) return false;
      }
    }
    return true;
  };
  const stuck = new Set<string>();
  for (let round = 0; round < 200; round++) {
    let conflict: { a: string; b: string; ia: number; ib: number } | null = null;
    search: for (const [position, a] of keys.entries()) {
      for (const b of keys.slice(position + 1)) {
        const pa = routes.get(a)!; const pb = routes.get(b)!;
        if (stuck.has(`${a}~${b}`) || !unrelated(a, b, pa, pb)) continue;
        for (let i = 1; i < pa.length; i++) {
          for (let j = 1; j < pb.length; j++) {
            if (sharedLength(pa[i - 1]!, pa[i]!, pb[j - 1]!, pb[j]!) > 1) { conflict = { a, b, ia: i - 1, ib: j - 1 }; break search; }
          }
        }
      }
    }
    if (!conflict) return;
    let moved = false;
    for (const [key, index] of [[conflict.b, conflict.ib], [conflict.a, conflict.ia]] as const) {
      const points = routes.get(key)!;
      if (index === 0 || index === points.length - 2) continue;
      for (const offset of LANE_STEPS) {
        const candidate = shiftSegment(points, index, offset);
        if (candidate && clears(key, candidate)) {
          routes.set(key, candidate);
          moved = true;
          break;
        }
      }
      if (moved) break;
    }
    if (!moved) stuck.add(`${conflict.a}~${conflict.b}`);
  }
}

/** Places each label by its own wire where it covers the least of boxes, labels and other wires. */
function placeLabels(structure: Structure, routes: Map<string, Point[]>): Map<string, Point> {
  const boxes: Rect[] = [...structure.boxes.values()].filter((box) => box.obstacle)
    .map((box) => ({ x1: box.x, y1: box.y, x2: box.x + box.width, y2: box.y + box.height }));
  const texts = [...structure.boxes.values()].flatMap((box) => box.text);
  const placed: (Rect & { key: string })[] = [];
  const labels = new Map<string, Point>();
  const rectAt = (point: Point, width: number) => ({
    x1: point.x - width / 2, y1: point.y - LABEL_HEIGHT / 2, x2: point.x + width / 2, y2: point.y + LABEL_HEIGHT / 2,
  });
  for (const wire of structure.wires) {
    const points = routes.get(wire.key)!;
    const width = labelWidth(wire.label);
    let best: { point: Point; score: number } | null = null;
    for (let index = 1; index < points.length && wire.label; index++) {
      for (const { point, cost } of labelSpots(points[index - 1]!, points[index]!, width)) {
        const rect = rectAt(point, width);
        let score = cost;
        for (const box of boxes) score += 8 * overlapArea(rect, box);
        // Covering words or another label is never an acceptable trade.
        for (const text of texts) score += 10_000 * overlapArea(rect, text);
        for (const label of placed) score += 10_000 * overlapArea(rect, label);
        for (const [key, other] of routes) {
          if (key === wire.key) continue;
          for (let i = 1; i < other.length; i++) if (segmentHits(rect, other[i - 1]!, other[i]!)) score += 20;
        }
        if (!best || score < best.score) best = { point, score };
      }
    }
    const point = best?.point ?? points[Math.floor(points.length / 2)]!;
    labels.set(wire.key, point);
    if (wire.label) placed.push({ ...rectAt(point, width), key: wire.key });
  }
  return labels;
}

/** Routes the structural view. Every libavoid object is released before this returns. */
export function routeStructure(avoid: AvoidApi, structure: Structure): RouteTable {
  const router = new avoid.Router(avoid.RouterFlag.OrthogonalRouting.value);
  const values: AvoidObject[] = [];
  const keep = <T extends AvoidObject>(value: T) => (values.push(value), value);
  const routes = new Map<string, Point[]>();
  try {
    router.setRoutingParameter(avoid.RoutingParameter.shapeBufferDistance, SHAPE_BUFFER);
    router.setRoutingParameter(avoid.RoutingParameter.idealNudgingDistance, 10);
    router.setRoutingParameter(avoid.RoutingParameter.segmentPenalty, 40);
    router.setRoutingParameter(avoid.RoutingParameter.fixedSharedPathPenalty, 200);
    // Pins already space the ends; nudging the end segments would slide them off their ordered pins.
    router.setRoutingOption(avoid.RoutingOption.nudgeOrthogonalSegmentsConnectedToShapes, false);
    // Wires from one port form a trunk and split off where they turn, as a bus does.
    router.setRoutingOption(avoid.RoutingOption.nudgeSharedPathsWithCommonEndPoint, false);
    router.setRoutingOption(avoid.RoutingOption.penaliseOrthogonalSharedPathsAtConnEnds, true);

    const point = (x: number, y: number) => keep(new avoid.Point(x, y));
    const shapes = new Map<string, AvoidShape>();
    for (const [id, box] of [...structure.boxes].sort(([a], [b]) => a.localeCompare(b))) {
      if (!box.obstacle) {
        // Bands and containers stay open; only their caption words are an obstacle. The router pads
        // every shape by its buffer, so the caption shape is shrunk by that buffer less the clearance.
        const caption = captionOf(box);
        if (caption) {
          const inset = SHAPE_BUFFER - CAPTION_CLEARANCE;
          const cx = (caption.x1 + caption.x2) / 2; const cy = (caption.y1 + caption.y2) / 2;
          const half = Math.max(0.5, (caption.x2 - caption.x1) / 2 - inset);
          const tall = Math.max(0.5, (caption.y2 - caption.y1) / 2 - inset);
          // The router owns the shape and frees it with itself; only the rectangle is a temporary.
          new avoid.ShapeRef(router, keep(new avoid.Rectangle(point(cx - half, cy - tall), point(cx + half, cy + tall))));
        }
        continue;
      }
      const rect = keep(new avoid.Rectangle(point(box.x, box.y), point(box.x + box.width, box.y + box.height)));
      shapes.set(id, new avoid.ShapeRef(router, rect));
    }
    const pins = assignPins(structure);
    const classes = new Map<string, number>();
    const endFor = (id: string, end: WireEnd) => {
      const pin = pins.get(id)!;
      const shape = shapes.get(end.node);
      // A container is not an obstacle, so a wire ends on its edge as a free point.
      if (!shape) return keep(new avoid.ConnEnd(point(pin.x, pin.y)));
      let classId = classes.get(pin.group);
      if (classId === undefined) {
        classId = classes.size + 1;
        classes.set(pin.group, classId);
        const box = structure.boxes.get(end.node)!;
        const created = new avoid.ShapeConnectionPin(shape, classId, pin.x - box.x, pin.y - box.y, false, 0, LEAVES[pin.side]);
        created.setExclusive(!pin.shared);
      }
      return keep(new avoid.ConnEnd(shape, classId));
    };
    const connectors = structure.wires.map((wire) => [wire.key, new avoid.ConnRef(
      router, endFor(`${wire.key}#s`, wire.source), endFor(`${wire.key}#t`, wire.target),
    )] as const);
    router.processTransaction();
    for (const [key, connector] of connectors) {
      const line = keep(connector.displayRoute());
      const points: Point[] = [];
      for (let index = 0; index < line.size(); index++) {
        const at = keep(line.at(index));
        points.push({ x: at.x, y: at.y });
      }
      routes.set(key, simplify(points));
    }
  } finally {
    for (const value of values) value.delete();
    router.delete();
  }
  separateLanes(structure, routes);
  const labels = placeLabels(structure, routes);
  let x1 = 0; let y1 = 0; let x2 = 0; let y2 = 0;
  const grow = (x: number, y: number) => { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); };
  for (const box of structure.boxes.values()) { grow(box.x, box.y); grow(box.x + box.width, box.y + box.height); }
  for (const points of routes.values()) for (const { x, y } of points) grow(x, y);
  for (const wire of structure.wires) {
    const at = labels.get(wire.key)!;
    grow(at.x - labelWidth(wire.label) / 2, at.y - LABEL_HEIGHT / 2);
    grow(at.x + labelWidth(wire.label) / 2, at.y + LABEL_HEIGHT / 2);
  }
  return {
    routes: new Map([...routes].map(([key, points]) => [key, { points, label: labels.get(key)! }])),
    bounds: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 },
  };
}

/** The end points two wires have in common, where they join rather than cross. */
function sharedEnds(a: Point[], b: Point[]): Point[] {
  const ends = (points: Point[]) => [points[0]!, points[points.length - 1]!];
  return ends(a).filter((p) => ends(b).some((q) => Math.abs(p.x - q.x) < 1 && Math.abs(p.y - q.y) < 1));
}

/**
 * Where two wires cross, the horizontal one hops over the vertical one. Only the junction
 * around an end point both wires share is exempt; the same pair still hops elsewhere.
 */
export function crossingHops(wires: readonly { id: string; points: Point[] }[]): Map<string, Point[]> {
  const hops = new Map<string, Point[]>();
  const margin = HOP_RADIUS + 2;
  for (const [index, a] of wires.entries()) {
    for (const b of wires.slice(index + 1)) {
      const junctions = sharedEnds(a.points, b.points);
      const atJunction = (p: Point) => junctions.some((j) => Math.abs(p.x - j.x) + Math.abs(p.y - j.y) <= JUNCTION_RADIUS);
      for (const [over, under] of [[a, b], [b, a]] as const) {
        for (let i = 1; i < over.points.length; i++) {
          const h1 = over.points[i - 1]!; const h2 = over.points[i]!;
          if (h1.y !== h2.y) continue;
          for (let j = 1; j < under.points.length; j++) {
            const v1 = under.points[j - 1]!; const v2 = under.points[j]!;
            if (v1.x !== v2.x) continue;
            const inside = (value: number, p: number, q: number) => value > Math.min(p, q) + margin && value < Math.max(p, q) - margin;
            const crossing = { x: v1.x, y: h1.y };
            if (inside(v1.x, h1.x, h2.x) && inside(h1.y, v1.y, v2.y) && !atJunction(crossing)) {
              const list = hops.get(over.id) ?? [];
              if (!list.some((hop) => hop.x === crossing.x && hop.y === crossing.y)) list.push(crossing);
              hops.set(over.id, list);
            }
          }
        }
      }
    }
  }
  return hops;
}

/** Attaches routed geometry, and the hops where its wires cross, to the wires a view shows. */
export function withRoutes<E extends Edge<DiagramEdgeData>>(edges: readonly E[], table: RouteTable | null): E[] {
  const routed = edges.map((edge) => {
    const route = table?.routes.get(routeKey(edge));
    return route ? { ...edge, data: { ...edge.data, route } } : edge;
  });
  const hops = crossingHops(routed.flatMap((edge) => edge.data?.route ? [{ id: edge.id, points: edge.data.route.points }] : []));
  return routed.map((edge) => hops.has(edge.id) ? { ...edge, data: { ...edge.data, hops: hops.get(edge.id) } } : edge);
}

/**
 * An orthogonal SVG path with a small arc at each hop. Hops closer than one arc width merge
 * into one wider arc, so the path never runs backwards over itself.
 */
export function routePath(points: readonly Point[], hops: readonly Point[] = []): string {
  let path = `M${points[0]!.x},${points[0]!.y}`;
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!;
    const b = points[index]!;
    if (a.y === b.y && hops.length) {
      const direction = Math.sign(b.x - a.x);
      const xs = [...new Set(hops.filter((hop) => hop.y === a.y && (hop.x - a.x) * direction > 0 && (b.x - hop.x) * direction > 0)
        .map((hop) => hop.x))].sort((p, q) => (p - q) * direction);
      const spans: { from: number; to: number }[] = [];
      for (const x of xs) {
        const last = spans[spans.length - 1];
        if (last && (x - last.to) * direction <= 2 * HOP_RADIUS + 2) last.to = x;
        else spans.push({ from: x, to: x });
      }
      for (const { from, to } of spans) {
        const start = from - HOP_RADIUS * direction;
        const end = to + HOP_RADIUS * direction;
        path += ` L${start},${a.y} A${Math.abs(end - start) / 2},${HOP_RADIUS} 0 0 ${direction > 0 ? 1 : 0} ${end},${a.y}`;
      }
    }
    path += ` L${b.x},${b.y}`;
  }
  return path;
}
