// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { flows } from './catalog';
import { edgeGeometry, makeGraph, type FlowGraph, type StepNode } from './graph';
import { parseFlow } from './source';

type Point = [number, number];
function onSegment([x, y]: Point, [ax, ay]: Point, [bx, by]: Point) {
  return (ax === bx && x === ax && y >= Math.min(ay, by) && y <= Math.max(ay, by))
    || (ay === by && y === ay && x >= Math.min(ax, bx) && x <= Math.max(ax, bx));
}
function crossesCard(a: Point, b: Point, node: StepNode) {
  const { x, y } = node.position;
  return a[0] === b[0]
    ? a[0] > x && a[0] < x + node.width && Math.max(a[1], b[1]) > y && Math.min(a[1], b[1]) < y + node.height
    : a[1] > y && a[1] < y + node.height && Math.max(a[0], b[0]) > x && Math.min(a[0], b[0]) < x + node.width;
}

function reachable(graph: FlowGraph, start: string) {
  const seen = new Set([start]), queue = [start];
  for (const id of queue) {
    for (const edge of graph.edges.filter(edge => edge.source === id)) {
      if (!seen.has(edge.target)) { seen.add(edge.target); queue.push(edge.target); }
    }
  }
  return seen;
}

describe('the flow layout', () => {
  it('connects optional withdrawal to the pending proposal and ends that path before approval', () => {
    const document = parseFlow(flows.find(flow => flow.id === 'pool-creation')!);
    const graph = makeGraph(document);
    const steps = graph.nodes.filter((node): node is StepNode => node.type === 'step');
    const find = (label: string) => steps.find(node => node.data.label.includes(label))!;
    const pending = find('Create pending'), withdraw = find('PoolProposal_Withdraw');
    for (const action of ['PoolProposal_Withdraw', 'PoolProposal_Accept', 'PoolProposal_Reject']) {
      expect(reachable(graph, pending.id).has(find(action).id)).toBe(true);
    }
    const withdrawnPath = reachable(graph, withdraw.id);
    expect(withdrawnPath.has(find('PoolProposal_Accept').id)).toBe(false);
    expect(withdrawnPath.has(find('PoolProposal_Reject').id)).toBe(false);
    expect(withdrawnPath.has(find('PoolFactory_CreatePool').id)).toBe(false);
    expect(steps.filter(node => withdrawnPath.has(node.id)).map(node => node.data.kind)).toEqual(['exercise', 'archive', 'stop']);
    const group = graph.nodes.find(node => node.type === 'region')!;
    const enclosed = steps.filter(node => node.position.x >= group.position.x
      && node.position.x + node.width <= group.position.x + Number(group.style!.width)
      && node.position.y >= group.position.y
      && node.position.y + node.height <= group.position.y + Number(group.style!.height));
    expect(new Set(enclosed.map(node => node.id))).toEqual(withdrawnPath);
  });

  it.each(flows)('keeps $id connected with wires outside other cards', flow => {
    const graph = makeGraph(parseFlow(flow));
    const nodes = graph.nodes.filter((node): node is StepNode => node.type === 'step');
    const starts = nodes.filter(node => node.data.kind === 'start');
    expect(starts).toHaveLength(1);
    expect(reachable(graph, starts[0]!.id)).toEqual(new Set(nodes.map(node => node.id)));
    for (const edge of graph.edges) {
      expect(nodes.some(node => node.id === edge.source)).toBe(true);
      expect(nodes.some(node => node.id === edge.target)).toBe(true);
      const { points } = edgeGeometry(edge.data!);
      for (const [index, point] of points.slice(1).entries()) {
        const crossed = nodes.filter(node => node.id !== edge.source && node.id !== edge.target
          && crossesCard(points[index]!, point, node));
        expect(crossed.map(node => node.data.label), `${flow.id}: ${edge.id}`).toEqual([]);
      }
    }
  });

  it.each(flows.filter(flow => ['pool-swap', 'pool-provide-liquidity', 'pool-withdraw-liquidity'].includes(flow.id)))(
    'connects $id request to settlement or terminal recovery after the deadline', flow => {
      const graph = makeGraph(parseFlow(flow));
      const steps = graph.nodes.filter((node): node is StepNode => node.type === 'step');
      const find = (label: string) => steps.find(node => node.data.label.includes(label))!;
      const request = steps.find(node => node.data.label.startsWith('Return **'))!;
      const recovery = find('PoolAccess_RecoverAllocations');
      const settlement = find('VenueDelegation_');
      expect(reachable(graph, request.id).has(recovery.id)).toBe(true);
      expect(reachable(graph, request.id).has(settlement.id)).toBe(true);
      expect(reachable(graph, settlement.id).has(recovery.id)).toBe(false);
      const recoveryPath = reachable(graph, recovery.id);
      expect(recoveryPath.has(settlement.id)).toBe(false);
      expect(steps.filter(node => recoveryPath.has(node.id)).map(node => node.data.kind))
        .toEqual(['exercise', 'check', 'exercise', 'stop']);
      const group = graph.nodes.find(node => node.type === 'region')!;
      expect(group.data.label).toContain('after the deadline');
      const enclosed = steps.filter(node => node.position.x >= group.position.x
        && node.position.x + node.width <= group.position.x + group.width!
        && node.position.y >= group.position.y
        && node.position.y + node.height <= group.position.y + group.height!);
      expect(new Set(enclosed.map(node => node.id))).toEqual(recoveryPath);
    },
  );

  it('puts each decision label on its own wire with room for the label', () => {
    for (const flow of flows) {
      const graph = makeGraph(parseFlow(flow));
      for (const edge of graph.edges.filter(edge => edge.data!.source.data.kind === 'decision')) {
        const { label, points } = edgeGeometry(edge.data!);
        // A long branch names itself where it leaves the decision; a short one on its last run.
        const index = edge.data!.fork ? 1 : points.length - 1;
        expect(onSegment(label, points[index - 1]!, points[index]!)).toBe(true);
        expect(Math.abs(label[1] - points[index - 1]![1])).toBeGreaterThan(10);
        expect(Math.abs(label[1] - points[index]![1])).toBeGreaterThan(10);
        for (const sibling of graph.edges.filter(sibling => sibling.source === edge.source && sibling !== edge)) {
          const other = edgeGeometry(sibling.data!).points;
          expect(other.slice(1).some((point, index) => onSegment(label, other[index]!, point))).toBe(false);
        }
      }
    }
  });
});
