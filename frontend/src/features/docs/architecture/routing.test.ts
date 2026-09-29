// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import { layerIds, model } from './content';
import { buildGraph } from './graph';
import {
  captionOf, crossingHops, labelWidth, routePath, routeStructure, structureOf, withRoutes,
  type Point, type RouteTable,
} from './routing';
import { loadAvoid } from './useRoutes';

// Authored views draw their own wires; only the others go through libavoid.
const views = ['system', ...layerIds].filter((view) => !buildGraph(view).authored);
const tables = new Map<string, RouteTable>();
const graphOf = (view: string) => buildGraph(view);
const segments = (points: Point[]) => points.slice(1).map((b, i) => [points[i]!, b] as const);
const ends = (points: Point[]) => [points[0]!, points[points.length - 1]!];
const same = (p: Point, q: Point) => Math.abs(p.x - q.x) < 1 && Math.abs(p.y - q.y) < 1;

beforeAll(async () => {
  const avoid = await loadAvoid();
  for (const view of views) tables.set(view, routeStructure(avoid, structureOf(view)));
});

describe('routed wires', () => {
  it('run orthogonally from box to box and never through a box they do not attach to', () => {
    for (const view of views) {
      const structure = structureOf(view);
      const boxes = [...structure.boxes].filter(([, box]) => box.obstacle);
      for (const wire of structure.wires) {
        const { points } = tables.get(view)!.routes.get(wire.key)!;
        for (const [a, b] of segments(points)) expect(a.x === b.x || a.y === b.y, `${view}: ${wire.key}`).toBe(true);
        for (const [end, node] of [[points[0]!, wire.source.node], [points[points.length - 1]!, wire.target.node]] as const) {
          const box = structure.boxes.get(node)!;
          const onBorder = end.x >= box.x - 1 && end.x <= box.x + box.width + 1 && end.y >= box.y - 1 && end.y <= box.y + box.height + 1;
          expect(onBorder, `${view}: ${wire.key} ends on ${node}`).toBe(true);
        }
        for (const [a, b] of segments(points)) {
          for (const [id, box] of boxes) {
            const through = Math.min(a.x, b.x) < box.x + box.width - 1 && Math.max(a.x, b.x) > box.x + 1
              && Math.min(a.y, b.y) < box.y + box.height - 1 && Math.max(a.y, b.y) > box.y + 1;
            expect(through, `${view}: ${wire.key} crosses ${id}`).toBe(false);
          }
        }
      }
    }
  });

  it('pass through groups but never through the words of a group caption', () => {
    for (const view of views) {
      const structure = structureOf(view);
      const captions = [...structure.boxes].flatMap(([id, box]) => {
        const caption = captionOf(box);
        return caption ? [{ id, ...caption }] : [];
      });
      expect(captions.length, view).toBeGreaterThan(0);
      for (const [key, { points }] of tables.get(view)!.routes) {
        for (const [a, b] of segments(points)) {
          for (const caption of captions) {
            const through = Math.min(a.x, b.x) < caption.x2 && Math.max(a.x, b.x) > caption.x1
              && Math.min(a.y, b.y) < caption.y2 && Math.max(a.y, b.y) > caption.y1;
            expect(through, `${view}: ${key} crosses the ${caption.id} caption`).toBe(false);
          }
        }
      }
    }
  });

  it('keep every pair of wires on separate lines, unless they meet at a shared end', () => {
    for (const view of views) {
      const found: string[] = [];
      const wires = withRoutes(graphOf(view).edges, tables.get(view)!)
        .map((edge) => ({ id: edge.id, points: edge.data!.route!.points }));
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
              if (shared > 1) found.push(`${a.id}~${b.id} (${Math.round(shared)}px)`);
            }
          }
        }
      }
      expect(found, view).toEqual([]);
    }
  });

  it('attach several wires to one side in the order they travel, so they do not cross there', () => {
    const structure = structureOf('client');
    const into = structure.wires.filter((wire) => wire.target.node === model.N.http && wire.target.side === 'left');
    expect(into).toHaveLength(4);
    const byOrigin = [...into].sort((a, b) => structure.boxes.get(a.source.node)!.y - structure.boxes.get(b.source.node)!.y);
    const arrivals = byOrigin.map((wire) => tables.get('client')!.routes.get(wire.key)!.points.at(-1)!.y);
    expect(arrivals).toEqual([...arrivals].sort((a, b) => a - b));
    expect(new Set(arrivals).size).toBe(4);
  });

  it('never cover the words in a box with a label', () => {
    for (const view of views) {
      const structure = structureOf(view);
      const texts = [...structure.boxes].flatMap(([id, box]) => box.text.map((text) => ({ id, ...text })));
      for (const wire of structure.wires.filter((item) => item.label)) {
        const at = tables.get(view)!.routes.get(wire.key)!.label;
        const half = labelWidth(wire.label) / 2;
        const label = { x1: at.x - half, x2: at.x + half, y1: at.y - 9.5, y2: at.y + 9.5 };
        for (const text of texts) {
          const covered = label.x1 < text.x2 && text.x1 < label.x2 && label.y1 < text.y2 && text.y1 < label.y2;
          expect(covered, `${view}: "${wire.label}" covers text in ${text.id}`).toBe(false);
        }
      }
    }
  });

  it('keep labels clear of each other', () => {
    for (const view of views) {
      const structure = structureOf(view);
      const rects = structure.wires.filter((wire) => wire.label).map((wire) => {
        const at = tables.get(view)!.routes.get(wire.key)!.label;
        const half = labelWidth(wire.label) / 2;
        return { key: wire.key, x1: at.x - half, x2: at.x + half, y1: at.y - 9.5, y2: at.y + 9.5 };
      });
      for (const [index, a] of rects.entries()) {
        for (const b of rects.slice(index + 1)) {
          const clash = a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
          expect(clash, `${view}: ${a.key} and ${b.key}`).toBe(false);
        }
      }
    }
  });
});

describe('route stability', () => {
  it('routes the same view identically every time', async () => {
    const again = routeStructure(await loadAvoid(), structureOf('system'));
    expect([...again.routes]).toEqual([...tables.get('system')!.routes]);
  });

  it('routes every wire of every view', () => {
    for (const view of views) {
      for (const edge of withRoutes(graphOf(view).edges, tables.get(view)!)) expect(edge.data?.route, `${view}: ${edge.id}`).toBeDefined();
    }
  });
});

describe('crossing hops', () => {
  it('lift the horizontal wire where two unrelated wires cross', () => {
    const hops = crossingHops([
      { id: 'across', points: [{ x: 0, y: 50 }, { x: 100, y: 50 }] },
      { id: 'down', points: [{ x: 50, y: 0 }, { x: 50, y: 100 }] },
    ]);
    expect(hops.get('across')).toEqual([{ x: 50, y: 50 }]);
    expect(hops.has('down')).toBe(false);
  });

  it('never hop where one wire ends on another', () => {
    const hops = crossingHops([
      { id: 'across', points: [{ x: 0, y: 50 }, { x: 100, y: 50 }] },
      { id: 'joins', points: [{ x: 50, y: 0 }, { x: 50, y: 50 }] },
    ]);
    expect(hops.size).toBe(0);
  });

  it('exempt only the junction of wires that share an end, and still hop their remote crossing', () => {
    const hops = crossingHops([
      { id: 'a', points: [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 50 }] },
      { id: 'b', points: [{ x: 0, y: 0 }, { x: 0, y: -12 }, { x: 20, y: -12 }, { x: 20, y: 30 }, { x: 90, y: 30 }] },
    ]);
    // (20, 0) lies 20px from the shared start: part of the junction, no hop.
    expect(hops.get('a')).toBeUndefined();
    // (60, 30) lies 90px away: a real crossing of the same pair.
    expect(hops.get('b')).toEqual([{ x: 60, y: 30 }]);
  });

  it('hop the far crossing of two wires that leave one port', () => {
    const hops = crossingHops([
      { id: 'a', points: [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 300, y: 100 }] },
      { id: 'b', points: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }] },
    ]);
    expect(hops.get('a')).toEqual([{ x: 200, y: 100 }]);
  });

  it('record a crossing once', () => {
    const across = { id: 'across', points: [{ x: 0, y: 50 }, { x: 100, y: 50 }] };
    const hops = crossingHops([
      across,
      { id: 'down', points: [{ x: 50, y: 0 }, { x: 50, y: 100 }] },
      { id: 'again', points: [{ x: 50, y: -20 }, { x: 50, y: 120 }] },
    ]);
    expect(hops.get('across')).toEqual([{ x: 50, y: 50 }]);
  });
});

describe('hop paths', () => {
  const xs = (path: string) => [...path.matchAll(/[MLA]([^MLA]*)/g)].map((match) => {
    const numbers = match[1]!.trim().split(/[\s,]+/).map(Number);
    return numbers[numbers.length - 2]!;
  });

  it('merge hops closer than one arc width into one arc that never runs backwards', () => {
    const path = routePath([{ x: 0, y: 0 }, { x: 100, y: 0 }], [{ x: 50, y: 0 }, { x: 56, y: 0 }, { x: 60, y: 0 }, { x: 50, y: 0 }]);
    expect(path.match(/A/g)).toHaveLength(1);
    const along = xs(path);
    expect(along).toEqual([...along].sort((a, b) => a - b));
  });

  it('draw one arc per distant hop, in the direction of travel', () => {
    const path = routePath([{ x: 100, y: 0 }, { x: 0, y: 0 }], [{ x: 20, y: 0 }, { x: 80, y: 0 }]);
    expect(path.match(/A/g)).toHaveLength(2);
    const along = xs(path);
    expect(along).toEqual([...along].sort((a, b) => b - a));
    expect(path).toContain(' 0 0 0 ');
  });
});
