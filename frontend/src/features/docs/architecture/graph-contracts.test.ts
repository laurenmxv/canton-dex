// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { model } from './content';
import { CAPTION, TITLE_HEIGHT, choiceRowCenter } from './graph-base';
import { contractsGraph } from './graph-contracts';
import { labelWidth, type Point } from './routing';

const N = model.N;
const C = model.C;
const graph = contractsGraph();
type Built = typeof graph;
type Box = Built['nodes'][number];
type Rect = { x1: number; y1: number; x2: number; y2: number };

const byId = new Map(graph.nodes.map((n) => [n.id, n]));
const rectOf = (node: Box): Rect => ({ x1: node.position.x, y1: node.position.y, x2: node.position.x + node.width!, y2: node.position.y + node.height! });
const within = (inner: Rect, outer: Rect) => inner.x1 >= outer.x1 && inner.y1 >= outer.y1 && inner.x2 <= outer.x2 && inner.y2 <= outer.y2;
const overlaps = (a: Rect, b: Rect) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
const through = (a: Point, b: Point, r: Rect) => Math.min(a.x, b.x) < r.x2 - 1 && Math.max(a.x, b.x) > r.x1 + 1
  && Math.min(a.y, b.y) < r.y2 - 1 && Math.max(a.y, b.y) > r.y1 + 1;
const segments = (points: Point[]) => points.slice(1).map((b, i) => [points[i]!, b] as const);
const ends = (points: Point[]) => [points[0]!, points[points.length - 1]!];
const same = (p: Point, q: Point) => Math.abs(p.x - q.x) < 1 && Math.abs(p.y - q.y) < 1;
const cards = graph.nodes.filter((n) => n.data.kind !== 'boundary');
const boundaries = graph.nodes.filter((n) => n.data.kind === 'boundary');
const wires = graph.edges.map((e) => ({ id: e.id, text: String(e.label ?? ''), points: e.data!.route!.points, at: e.data!.route!.label }));
const labelRect = (at: Point, text: string): Rect => ({ x1: at.x - labelWidth(text) / 2, x2: at.x + labelWidth(text) / 2, y1: at.y - 9.5, y2: at.y + 9.5 });

// The 18 source-reviewed relations, with the choice rows a relation must start or end on.
const choice = (id: string, end: 'in' | 'out') => `choice-${id}-${end}`;
const relations: [string, string, string, string, string?, string?][] = [
  ['grant-kyc', N.ledgerApi!, N.kyc!, 'create'],
  ['grant-access', N.ledgerApi!, N.access!, 'create'],
  ['factory-proposal', N.factory!, N.proposal!, 'propose', choice(C.propose!, 'out')],
  ['proposal-accept', N.proposal!, N.factory!, 'accept', choice(C.accept!, 'out'), choice(C.create!, 'in')],
  ['dvo-accept', N.dvo!, N.proposal!, 'accept', undefined, choice(C.accept!, 'in')],
  ['dvo-grant', N.dvo!, N.delegation!, 'grant'],
  ['factory-pool', N.factory!, N.pool!, 'create', choice(C.create!, 'out')],
  ['factory-token-standard', N.factory!, N.tokenStandard!, 'check factories', choice(C.create!, 'out')],
  ['access-kyc', N.access!, N.kyc!, 'check KYC'],
  ['access-tokens', N.access!, N.tokenStandard!, 'allocate'],
  ['permission-pool', N.delegation!, N.pool!, 'settle'],
  ['pool-config', N.pool!, N.config!, 'read'],
  ['pool-state', N.pool!, N.state!, 'replace'],
  ['pool-swap-result', N.pool!, N.swapReceipt!, 'create'],
  ['pool-liquidity-result', N.pool!, N.liquidityReceipt!, 'create'],
  ['delegation-access', N.delegation!, N.access!, 'check access'],
  ['delegation-kyc', N.delegation!, N.kyc!, 'check KYC'],
  ['pool-tokens', N.pool!, N.tokenStandard!, 'settle allocations'],
];

/** Where a handle meets its box: a choice row's exact centre, or anywhere on the named side. */
function endOk(point: Point, node: Box, handle: string): boolean {
  const r = rectOf(node);
  const row = /^choice-(.+)-(in|out)$/.exec(handle);
  if (row) {
    const index = node.data.choices!.findIndex((c) => c.id === row[1]);
    return index >= 0 && point.x === (row[2] === 'in' ? r.x1 : r.x2) && point.y === r.y1 + choiceRowCenter(index);
  }
  const side = { in: 'left', 'left-out': 'left', out: 'right', 'right-in': 'right', 'top-in': 'top', 'top-out': 'top', 'bottom-in': 'bottom', 'bottom-out': 'bottom' }[handle];
  if (side === 'left' || side === 'right') {
    const x = side === 'left' ? r.x1 : r.x2;
    // A template-level wire on a side stays in the heading, clear of every choice row.
    const top = node.data.choices?.length ? r.y1 + TITLE_HEIGHT : r.y2;
    return point.x === x && point.y > r.y1 && point.y < top;
  }
  const y = side === 'top' ? r.y1 : r.y2;
  return point.y === y && point.x > r.x1 && point.x < r.x2;
}

describe('contracts structure', () => {
  it('draws the ten templates, three context boxes, every choice row and the five groups', () => {
    const templates = cards.filter((n) => n.data.kind === 'template');
    expect(templates).toHaveLength(10);
    expect(cards.filter((n) => n.data.kind === 'context').map((n) => n.id).sort()).toEqual([N.dvo!, N.ledgerApi!, N.tokenStandard!].sort());
    expect(templates.flatMap((n) => n.data.choices!.map((c) => c.id)).sort()).toEqual(Object.keys(model.choices).sort());
    expect(boundaries.map((n) => n.data.label).sort()).toEqual(['Access', 'Outcomes', 'Pool creation', 'Pool engine', 'Settlement authority']);
    const members: Record<string, string[]> = {
      'Pool creation': [N.proposal!, N.factory!], Access: [N.kyc!, N.access!], 'Settlement authority': [N.delegation!],
      'Pool engine': [N.pool!, N.config!, N.state!], Outcomes: [N.swapReceipt!, N.liquidityReceipt!],
    };
    for (const group of boundaries) {
      const inside = cards.filter((n) => within(rectOf(n), rectOf(group))).map((n) => n.id).sort();
      expect(inside, group.data.label).toEqual(members[group.data.label]!.sort());
    }
  });

  it('keeps exactly the source-reviewed relations, on their choice rows where they belong', () => {
    expect(graph.edges.map((e) => e.id).sort()).toEqual(relations.map(([id]) => id).sort());
    for (const [id, source, target, label, sourceHandle, targetHandle] of relations) {
      const edge = graph.edges.find((e) => e.id === id)!;
      expect([edge.source, edge.target, edge.label], id).toEqual([source, target, label]);
      if (sourceHandle) expect(edge.sourceHandle, id).toBe(sourceHandle);
      else expect(edge.sourceHandle?.startsWith('choice-'), `${id} is not a choice relation`).toBe(false);
      if (targetHandle) expect(edge.targetHandle, id).toBe(targetHandle);
      else expect(edge.targetHandle?.startsWith('choice-'), `${id} is not a choice relation`).toBe(false);
    }
    expect(graph.edges.some((e) => e.source === N.access && e.target === N.delegation), 'no synchronous request-to-settlement call').toBe(false);
  });
});

describe('contracts authored wires', () => {
  it('run orthogonally from the handle they name, on a choice row only when the relation is about that choice', () => {
    for (const edge of graph.edges) {
      const { points } = edge.data!.route!;
      for (const [a, b] of segments(points)) expect((a.x === b.x) !== (a.y === b.y), edge.id).toBe(true);
      expect(endOk(points[0]!, byId.get(edge.source)!, edge.sourceHandle!), `${edge.id} leaves ${edge.sourceHandle}`).toBe(true);
      expect(endOk(points.at(-1)!, byId.get(edge.target)!, edge.targetHandle!), `${edge.id} enters ${edge.targetHandle}`).toBe(true);
      expect(edge.data?.hops, edge.id).toBeUndefined();
    }
  });

  it('never cross a card, its choice rows, or a group caption', () => {
    const captions = boundaries.map((n) => ({
      id: n.id, x1: n.position.x + 16, y1: n.position.y + 10, x2: n.position.x + 16 + n.data.label.length * CAPTION.charWidth, y2: n.position.y + CAPTION.bottom,
    }));
    for (const wire of wires) {
      for (const [a, b] of segments(wire.points)) {
        for (const card of cards) expect(through(a, b, rectOf(card)), `${wire.id} crosses ${card.id}`).toBe(false);
        for (const caption of captions) expect(through(a, b, caption), `${wire.id} crosses the ${caption.id} caption`).toBe(false);
      }
    }
  });

  it('keep unrelated wires on separate lines, with no end or bend touching another wire', () => {
    const found: string[] = [];
    for (const [index, a] of wires.entries()) {
      for (const b of wires.slice(index + 1)) {
        // Two relations from one choice leave it together; that shared port is their real junction.
        if (ends(a.points).some((p) => ends(b.points).some((q) => same(p, q)))) continue;
        for (const [a1, a2] of segments(a.points)) {
          for (const [b1, b2] of segments(b.points)) {
            const horizontal = a1.y === a2.y && b1.y === b2.y && a1.y === b1.y;
            const vertical = a1.x === a2.x && b1.x === b2.x && a1.x === b1.x;
            if (!horizontal && !vertical) continue;
            const axis = horizontal ? 'x' : 'y';
            const shared = Math.min(Math.max(a1[axis], a2[axis]), Math.max(b1[axis], b2[axis]))
              - Math.max(Math.min(a1[axis], a2[axis]), Math.min(b1[axis], b2[axis]));
            if (shared > -16) found.push(`${a.id}~${b.id} share or crowd a lane`);
          }
        }
        for (const [one, other] of [[a, b], [b, a]] as const) {
          for (const p of one.points) {
            for (const [s1, s2] of segments(other.points)) {
              const near = p.x >= Math.min(s1.x, s2.x) - 15 && p.x <= Math.max(s1.x, s2.x) + 15
                && p.y >= Math.min(s1.y, s2.y) - 15 && p.y <= Math.max(s1.y, s2.y) + 15;
              const parallelGap = s1.x === s2.x ? Math.abs(p.x - s1.x) : Math.abs(p.y - s1.y);
              if (near && parallelGap < 15) found.push(`${one.id} touches ${other.id}`);
            }
          }
        }
      }
    }
    expect(found).toEqual([]);
  });

  it('cross nowhere', () => {
    const crossings: string[] = [];
    for (const [index, a] of wires.entries()) {
      for (const b of wires.slice(index + 1)) {
        for (const [over, under] of [[a, b], [b, a]] as const) {
          for (const [h1, h2] of segments(over.points).filter(([p, q]) => p.y === q.y)) {
            for (const [v1, v2] of segments(under.points).filter(([p, q]) => p.x === q.x)) {
              const x = v1.x; const y = h1.y;
              if (x > Math.min(h1.x, h2.x) && x < Math.max(h1.x, h2.x) && y > Math.min(v1.y, v2.y) && y < Math.max(v1.y, v2.y)) {
                crossings.push(`${a.id} x ${b.id} at ${x},${y}`);
              }
            }
          }
        }
      }
    }
    expect(crossings).toEqual([]);
  });

  it('place every label on its own wire, clear of cards, captions, other labels and other wires', () => {
    const captions = boundaries.map((n) => ({
      x1: n.position.x + 16, y1: n.position.y + 10, x2: n.position.x + 16 + n.data.label.length * CAPTION.charWidth, y2: n.position.y + CAPTION.bottom,
    }));
    const labels = wires.filter((w) => w.text).map((w) => ({ ...w, rect: labelRect(w.at, w.text) }));
    for (const [index, label] of labels.entries()) {
      const onOwn = segments(label.points).some(([p, q]) => label.at.x >= Math.min(p.x, q.x) && label.at.x <= Math.max(p.x, q.x)
        && label.at.y >= Math.min(p.y, q.y) && label.at.y <= Math.max(p.y, q.y));
      expect(onOwn, `${label.id} label sits on its wire`).toBe(true);
      for (const other of labels.slice(index + 1)) expect(overlaps(label.rect, other.rect), `${label.id} and ${other.id}`).toBe(false);
      for (const card of cards) expect(overlaps(label.rect, rectOf(card)), `${label.id} covers ${card.id}`).toBe(false);
      for (const caption of captions) expect(overlaps(label.rect, caption), `${label.id} covers a caption`).toBe(false);
      for (const wire of wires.filter((w) => w.id !== label.id)) {
        for (const [p, q] of segments(wire.points)) {
          const hit = Math.min(p.x, q.x) <= label.rect.x2 && label.rect.x1 <= Math.max(p.x, q.x)
            && Math.min(p.y, q.y) <= label.rect.y2 && label.rect.y1 <= Math.max(p.y, q.y);
          expect(hit, `${label.id} label crosses ${wire.id}`).toBe(false);
        }
      }
    }
  });
});
