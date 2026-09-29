// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { layerIds, model } from './content';
import { buildGraph } from './graph';
import { CAPTION } from './graph-base';
import { BUSINESS_GROUP, NETWORK, SETTLEMENT_GROUP, backendDisplayGraph } from './graph-backend';
import { PARTICIPANT, backendGraph } from './graph-layers';
import { labelWidth, type Point } from './routing';

const N = model.N;
const business = [N.onboarding!, N.pools!, N.swaps!, N.liquidity!, N.tokens!];
const settlement = [N.settlementQueues!, N.settlementDecision!, N.settlements!, N.settlementAutomation!];
const canton = [N.ledgerApi!, N.synchronizer!, N.dvo!];
const semantic = backendGraph();
const display = backendDisplayGraph();
type Built = typeof display;
type Rect = { x1: number; y1: number; x2: number; y2: number };

const rectOf = (graph: Built, id: string): Rect => {
  const node = graph.nodes.find((n) => n.id === id)!;
  return { x1: node.position.x, y1: node.position.y, x2: node.position.x + node.width!, y2: node.position.y + node.height! };
};
const within = (inner: Rect, outer: Rect) => inner.x1 >= outer.x1 && inner.y1 >= outer.y1 && inner.x2 <= outer.x2 && inner.y2 <= outer.y2;
const overlaps = (a: Rect, b: Rect) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
const components = (graph: Built) => graph.nodes.filter((n) => n.data.kind !== 'boundary');
const segments = (points: Point[]) => points.slice(1).map((b, i) => [points[i]!, b] as const);
const ends = (points: Point[]) => [points[0]!, points[points.length - 1]!];
const same = (p: Point, q: Point) => Math.abs(p.x - q.x) < 1 && Math.abs(p.y - q.y) < 1;
const onBorder = (p: Point, r: Rect) => p.x >= r.x1 - 1 && p.x <= r.x2 + 1 && p.y >= r.y1 - 1 && p.y <= r.y2 + 1
  && !(p.x > r.x1 + 1 && p.x < r.x2 - 1 && p.y > r.y1 + 1 && p.y < r.y2 - 1);
const through = (a: Point, b: Point, r: Rect) => Math.min(a.x, b.x) < r.x2 - 1 && Math.max(a.x, b.x) > r.x1 + 1
  && Math.min(a.y, b.y) < r.y2 - 1 && Math.max(a.y, b.y) > r.y1 + 1;
const wires = display.edges.map((edge) => ({
  id: edge.id, text: String(edge.label ?? ''), points: edge.data!.route!.points, at: edge.data!.route!.label,
}));
const labelRect = (at: Point, label: string): Rect => {
  const half = labelWidth(label) / 2;
  return { x1: at.x - half, x2: at.x + half, y1: at.y - 9.5, y2: at.y + 9.5 };
};

const expected = {
  'backend-routes-business': { label: 'routes', source: N.api, target: BUSINESS_GROUP, prefix: 'backend-route-' },
  'backend-ledger-business': { label: 'ledger ports', source: BUSINESS_GROUP, target: N.adapters, prefix: 'backend-ledger-' },
  'backend-persist-business': { label: 'records', source: BUSINESS_GROUP, target: N.stores, prefix: 'backend-persist-' },
};
const aggregates = display.edges.filter((edge) => edge.data?.members);

describe('backend display graph', () => {
  it('draws exactly the semantic components, inside the Backend and the Canton network groups', () => {
    const identity = (graph: Built) => components(graph).map((n) => [n.id, n.data.label, n.data.entityId, n.data.kind].join('|')).sort();
    expect(identity(display)).toEqual(identity(semantic));
    expect(display.nodes.filter((n) => n.data.kind === 'boundary').map((n) => [n.id, n.data.label])).toEqual([
      ['backend-boundary', 'Backend'], [NETWORK, 'Canton network'], [PARTICIPANT, 'Canton participant'],
      [BUSINESS_GROUP, 'Business modules'], [SETTLEMENT_GROUP, 'Settlements'],
    ]);
    const backend = rectOf(display, 'backend-boundary');
    const network = rectOf(display, NETWORK);
    expect(overlaps(backend, network), 'the network lies outside the Backend').toBe(false);
    for (const id of [...settlement, ...business]) expect(within(rectOf(display, id), backend), id).toBe(true);
    const inSettlement = components(display).filter((n) => within(rectOf(display, n.id), rectOf(display, SETTLEMENT_GROUP)));
    expect(inSettlement.map((n) => n.id).sort()).toEqual([...settlement].sort());
    for (const id of canton) {
      expect(within(rectOf(display, id), network), id).toBe(true);
      expect(overlaps(rectOf(display, id), backend), id).toBe(false);
    }
    const inParticipant = components(display).filter((n) => within(rectOf(display, n.id), rectOf(display, PARTICIPANT)));
    expect(inParticipant.map((n) => n.id), 'the Ledger API is a participant capability').toEqual([N.ledgerApi]);
    const database = rectOf(display, N.database!);
    expect(overlaps(database, backend) || overlaps(database, network), 'PostgreSQL is outside both').toBe(false);
  });

  it('keeps every semantic relation, either drawn as it is or as a member of one aggregate', () => {
    const byId = new Map(semantic.edges.map((edge) => [edge.id, edge]));
    const covered = [...display.edges.filter((e) => !e.data?.members).map((e) => e.id), ...aggregates.flatMap((e) => e.data!.members!)];
    expect(covered.sort()).toEqual([...byId.keys()].sort());
    const fields = (edge: Built['edges'][number]) => [edge.source, edge.target, edge.label, edge.data?.structural ?? false, edge.style, edge.markerEnd];
    for (const edge of display.edges.filter((e) => !e.data?.members)) expect(fields(edge), edge.id).toEqual(fields(byId.get(edge.id)!));
  });

  it('aggregates only the relations all five business modules share, and ends them on the group', () => {
    expect(aggregates.map((e) => e.id).sort()).toEqual(Object.keys(expected).sort());
    const group = rectOf(display, BUSINESS_GROUP);
    for (const id of business) expect(within(rectOf(display, id), group), id).toBe(true);
    for (const aggregate of aggregates) {
      const want = expected[aggregate.id as keyof typeof expected];
      expect([aggregate.source, aggregate.target, aggregate.label], aggregate.id).toEqual([want.source, want.target, want.label]);
      expect(aggregate.data?.structural).toBe(false);
      expect(aggregate.data?.summary, aggregate.id).toContain(`${business.length} relations`);
      const members = aggregate.data!.members!.map((id) => semantic.edges.find((e) => e.id === id)!);
      const fromGroup = aggregate.source === BUSINESS_GROUP;
      for (const member of members) {
        expect(member.id.startsWith(want.prefix), member.id).toBe(true);
        expect(member.data?.structural, member.id).toBe(false);
        expect(fromGroup ? member.target : member.source, member.id).toBe(fromGroup ? aggregate.target : aggregate.source);
      }
      expect(members.map((m) => (fromGroup ? m.source : m.target)).sort(), aggregate.id).toEqual([...business].sort());
      expect([...new Set(members.map((m) => m.label).filter(Boolean))], aggregate.id).toEqual([want.label]);
    }
  });

  it('keeps the settlement relations out of the business aggregates, and the shared rows structural', () => {
    for (const id of settlement) expect(overlaps(rectOf(display, id), rectOf(display, BUSINESS_GROUP)), id).toBe(false);
    const members = aggregates.flatMap((e) => e.data!.members!);
    for (const edge of semantic.edges.filter((e) => settlement.includes(e.source) || settlement.includes(e.target))) {
      expect(members, edge.id).not.toContain(edge.id);
      expect(display.edges.some((e) => e.id === edge.id), edge.id).toBe(true);
    }
    const shared = display.edges.find((e) => e.id === 'backend-shared-requests')!;
    expect([shared.source, shared.target, shared.data?.structural]).toEqual([N.stores, N.settlementQueues, true]);
    expect(shared.data?.summary).toMatch(/Swaps and Liquidity.*not copied/);
  });

});

describe('backend authored wires', () => {
  const cards = components(display).map((n) => ({ id: n.id, ...rectOf(display, n.id) }));

  it('run orthogonally from border to border, never through a card or the group', () => {
    const groups = [BUSINESS_GROUP, SETTLEMENT_GROUP].map((id) => ({ id, ...rectOf(display, id) }));
    for (const edge of display.edges) {
      const { points } = edge.data!.route!;
      expect(points.length, edge.id).toBeGreaterThanOrEqual(2);
      for (const [a, b] of segments(points)) expect((a.x === b.x) !== (a.y === b.y), edge.id).toBe(true);
      expect(onBorder(points[0]!, rectOf(display, edge.source)), `${edge.id} leaves ${edge.source}`).toBe(true);
      expect(onBorder(points.at(-1)!, rectOf(display, edge.target)), `${edge.id} enters ${edge.target}`).toBe(true);
      for (const [a, b] of segments(points)) {
        for (const card of cards) expect(through(a, b, card), `${edge.id} crosses ${card.id}`).toBe(false);
        // A wire may enter a group only to reach one of its members.
        for (const group of groups.filter((g) => ![edge.source, edge.target].some((id) => within(rectOf(display, id), g) || id === g.id))) {
          expect(through(a, b, group), `${edge.id} crosses ${group.id}`).toBe(false);
        }
      }
      expect(edge.data?.hops, edge.id).toBeUndefined();
    }
  });

  it('keep every pair of wires on separate lines and never touch another wire with an end or bend', () => {
    const found: string[] = [];
    for (const [index, a] of wires.entries()) {
      for (const b of wires.slice(index + 1)) {
        if (ends(a.points).some((p) => ends(b.points).some((q) => same(p, q)))) continue;
        for (const [a1, a2] of segments(a.points)) {
          for (const [b1, b2] of segments(b.points)) {
            const horizontal = a1.y === a2.y && b1.y === b2.y && a1.y === b1.y;
            const vertical = a1.x === a2.x && b1.x === b2.x && a1.x === b1.x;
            if (!horizontal && !vertical) continue;
            const axis = horizontal ? 'x' : 'y';
            const shared = Math.min(Math.max(a1[axis], a2[axis]), Math.max(b1[axis], b2[axis]))
              - Math.max(Math.min(a1[axis], a2[axis]), Math.min(b1[axis], b2[axis]));
            if (shared > 1) found.push(`${a.id}~${b.id}`);
          }
        }
        for (const [one, other] of [[a, b], [b, a]] as const) {
          for (const p of one.points) {
            for (const [s1, s2] of segments(other.points)) {
              const touches = p.x >= Math.min(s1.x, s2.x) - 1 && p.x <= Math.max(s1.x, s2.x) + 1
                && p.y >= Math.min(s1.y, s2.y) - 1 && p.y <= Math.max(s1.y, s2.y) + 1;
              if (touches) found.push(`${one.id} touches ${other.id}`);
            }
          }
        }
      }
    }
    expect(found).toEqual([]);
  });

  it('cross only at the four planned places, well clear of every end and bend', () => {
    const crossings: string[] = [];
    for (const [index, a] of wires.entries()) {
      for (const b of wires.slice(index + 1)) {
        for (const [over, under] of [[a, b], [b, a]] as const) {
          for (const [h1, h2] of segments(over.points).filter(([p, q]) => p.y === q.y)) {
            for (const [v1, v2] of segments(under.points).filter(([p, q]) => p.x === q.x)) {
              const at = { x: v1.x, y: h1.y };
              if (!(at.x > Math.min(h1.x, h2.x) && at.x < Math.max(h1.x, h2.x) && at.y > Math.min(v1.y, v2.y) && at.y < Math.max(v1.y, v2.y))) continue;
              const clearance = Math.min(...[...a.points, ...b.points].map((p) => Math.hypot(p.x - at.x, p.y - at.y)));
              expect(clearance, `${a.id} x ${b.id}`).toBeGreaterThanOrEqual(20);
              crossings.push(`${[a.id, b.id].sort().join(' x ')} at ${at.x},${at.y}`);
            }
          }
        }
      }
    }
    expect(crossings.sort()).toEqual([
      'backend-accounts-sql x backend-compose-router at 95,362',
      `backend-accounts-sql x backend-ledger-${N.settlements} at 1290,1078`,
      'backend-activity-history x backend-route-settlement at 840,764',
      `backend-ledger-${N.settlements} x backend-sql at 1350,652`,
    ]);
  });

  it('keep wires and labels off every group caption', () => {
    const captions = display.nodes.filter((n) => n.data.kind === 'boundary').map((n) => ({
      id: n.id, x1: n.position.x + 16, y1: n.position.y + 10,
      x2: n.position.x + 16 + n.data.label.length * CAPTION.charWidth, y2: n.position.y + CAPTION.bottom,
    }));
    for (const wire of wires) {
      for (const caption of captions) {
        for (const [a, b] of segments(wire.points)) expect(through(a, b, caption), `${wire.id} crosses the ${caption.id} caption`).toBe(false);
        if (wire.text) expect(overlaps(labelRect(wire.at, wire.text), caption), `${wire.id} label covers the ${caption.id} caption`).toBe(false);
      }
    }
  });

  it('place labels clear of each other, of cards and of other wires', () => {
    const labels = wires.filter((wire) => wire.text).map((wire) => ({ id: wire.id, rect: labelRect(wire.at, wire.text) }));
    for (const [index, a] of labels.entries()) {
      for (const b of labels.slice(index + 1)) expect(overlaps(a.rect, b.rect), `${a.id} and ${b.id}`).toBe(false);
      for (const card of cards) expect(overlaps(a.rect, card), `${a.id} covers ${card.id}`).toBe(false);
      for (const wire of wires.filter((w) => w.id !== a.id)) {
        for (const [p, q] of segments(wire.points)) {
          const line = { x1: Math.min(p.x, q.x), y1: Math.min(p.y, q.y), x2: Math.max(p.x, q.x), y2: Math.max(p.y, q.y) };
          const hit = line.x1 <= a.rect.x2 && a.rect.x1 <= line.x2 && line.y1 <= a.rect.y2 && a.rect.y1 <= line.y2;
          expect(hit, `${a.id} label crosses ${wire.id}`).toBe(false);
        }
      }
    }
  });
});

describe('authored views', () => {
  it('draws only the Backend and Contracts with authored wires', () => {
    const authored = ['backend', 'contracts'];
    for (const view of ['system', ...layerIds]) expect(Boolean(buildGraph(view).authored), view).toBe(authored.includes(view));
  });
});
