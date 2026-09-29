import { describe, expect, it } from 'vitest';
import { layerIds, model } from './content';
import { buildGraph } from './graph';
import { backendGraph } from './graph-layers';

const N = model.N;
const views = ['system', ...layerIds];
const render = (view = 'system') => buildGraph(view);

type Built = ReturnType<typeof render>;
type Box = Built['nodes'][number];
const nodeOf = (graph: Built, id: string) => graph.nodes.find((n) => n.id === id)!;
const inside = (inner: Box, outer: Box) => inner.position.x >= outer.position.x
  && inner.position.y >= outer.position.y
  && inner.position.x + inner.width! <= outer.position.x + outer.width!
  && inner.position.y + inner.height! <= outer.position.y + outer.height!;

describe('architecture structure', () => {
  it('has connected boxes and valid ports in every view', () => {
    for (const view of views) {
      const graph = render(view);
      const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
      expect(nodes.size, `${view}: duplicate box IDs`).toBe(graph.nodes.length);
      expect(new Set(graph.edges.map((e) => e.id)).size, `${view}: duplicate wire IDs`).toBe(graph.edges.length);
      expect(graph.edges.length, `${view}: missing arrows`).toBeGreaterThan(0);
      for (const edge of graph.edges) {
        for (const [id, handle] of [[edge.source, edge.sourceHandle], [edge.target, edge.targetHandle]]) {
          const node = nodes.get(id!);
          expect(node, `${view}: ${edge.id} has missing endpoint ${id}`).toBeDefined();
          if (handle?.startsWith('choice-')) {
            const choice = handle.replace(/^choice-/, '').replace(/-(in|out)$/, '');
            expect(node!.data.choices?.some((c) => c.id === choice), `${view}: wrong choice owner ${choice}`).toBe(true);
          }
        }
      }
    }
  });

  it('draws one neutral map per view, with no flow state on any box or wire', () => {
    for (const view of views) {
      const graph = render(view);
      for (const node of graph.nodes) {
        expect(Object.keys(node.data).filter((key) => ['active', 'effect'].includes(key)), node.id).toEqual([]);
        for (const choice of node.data.choices ?? []) expect(Object.keys(choice).sort(), choice.id).toEqual(['controller', 'id', 'label']);
      }
      expect(new Set(graph.edges.map((e) => e.style?.stroke)).size, view).toBe(1);
      for (const edge of graph.edges) expect(Object.keys(edge.data ?? {}).filter((key) => ['active', 'prepared'].includes(key)), edge.id).toEqual([]);
    }
  });

  it('links every layer view from the system diagram and keeps Canton as runtime context only', () => {
    const graph = render();
    const destinations = new Set(graph.nodes.filter((n) => n.data.kind === 'layer').map((n) => n.data.layerId));
    expect([...destinations].sort()).toEqual([...layerIds].sort());
    expect(graph.nodes.some((n) => n.data.entityId === 'external.dvo')).toBe(true);
    const runtime = nodeOf(graph, 'canton-runtime');
    expect(runtime.data.kind, 'no drill-down').not.toBe('layer');
    expect(runtime.data.layerId, 'hover explains the Canton layer').toBe('canton');
    for (const id of ['e-backend', 'e-hosts', 'e-synchronizer']) {
      expect(graph.edges.find((e) => e.id === id)?.[id === 'e-backend' ? 'target' : 'source'], id).toBe(runtime.id);
    }
  });

  it('distinguishes Fastify request routing from application startup', () => {
    const graph = backendGraph();
    expect(graph.edges.find((e) => e.id === 'backend-client')?.target).toBe(N.api);
    expect(graph.edges.find((e) => e.id === 'backend-compose-router')?.data?.structural).toBe(true);
  });

  it('routes domain requests through Fastify while IAM remains an authentication hook', () => {
    const graph = backendGraph();
    const domainRoutes = graph.edges.filter((e) => e.id.startsWith('backend-route-') || e.id === 'backend-activity-route');
    expect(domainRoutes).toHaveLength(7);
    for (const edge of domainRoutes) expect(edge.source, edge.id).toBe(N.api);
    const authentication = graph.edges.find((e) => e.id === 'backend-authenticate');
    expect([authentication?.source, authentication?.target]).toEqual([N.api, N.iam]);
    expect(domainRoutes.some((e) => e.source === N.iam)).toBe(false);
  });

  it('shows Activity as a consumer of stored history without trade-execution arrows', () => {
    const graph = backendGraph();
    const history = graph.edges.find((e) => e.id === 'backend-activity-history');
    expect([history?.source, history?.target, history?.label]).toEqual([N.activity, N.stores, 'reads history']);
    const tradeModules = [N.swaps, N.liquidity];
    expect(graph.edges.some((e) => e.source === N.activity && tradeModules.includes(e.target))).toBe(false);
    expect(graph.edges.some((e) => e.source === N.activity && e.target === N.database)).toBe(false);
  });

  it('shows every documented backend module inside the Backend boundary, and Canton outside it', () => {
    const graph = render('backend');
    const boundary = nodeOf(graph, 'backend-boundary');
    for (const id of model.layers.backend!.nodes) expect(inside(nodeOf(graph, id), boundary), id).toBe(true);
    for (const id of [N.ledgerApi!, N.synchronizer!, N.dvo!, N.database!]) expect(inside(nodeOf(graph, id), boundary), id).toBe(false);
  });

  it('draws the DVO as party context without assuming its host participant or process connections', () => {
    for (const graph of [backendGraph(), render()]) {
      const wires = graph.edges.filter((e) => e.source === N.dvo || e.target === N.dvo);
      expect(wires).toEqual([]);
    }
    expect(nodeOf(render(), N.dvo!).data.kind).toBe('context');
    expect(model.nodes[N.dvo!]!.external, 'a party, not an external service').toBeFalsy();
    for (const view of views) expect(render(view).nodes.some((n) => n.id === 'backend.bootstrap'), view).toBe(false);
  });

  it('splits settlement into queues, planning, execution and two independent loops', () => {
    const graph = backendGraph();
    const pairs = graph.edges.map((e) => [e.source, e.target, e.label] as const);
    for (const expected of [
      [N.settlementQueues, N.settlementDecision, 'FIFO order'], [N.settlementDecision, N.settlements, 'batch'],
      [N.settlementAutomation, N.settlementDecision, 'automatic'], [N.settlementAutomation, N.settlements, 'recovery'],
      [N.api, N.settlementDecision, 'manual'], [N.settlements, N.adapters, 'ledger operations'],
      [N.settlements, N.settlementQueues, 'claim / confirm'],
    ]) expect(pairs, expected.join(' → ')).toContainEqual(expected);
    // The queues read the rows the domain stores hold; no business module sends to them.
    const shared = graph.edges.find((e) => e.id === 'backend-shared-requests');
    expect([shared?.source, shared?.target, shared?.data?.structural]).toEqual([N.stores, N.settlementQueues, true]);
    expect(graph.edges.filter((e) => e.target === N.settlements).map((e) => e.source).sort(), 'no trigger bypasses planning except recovery')
      .toEqual([N.settlementAutomation!, N.settlementDecision!].sort());
    const intoQueues = graph.edges.filter((e) => e.target === N.settlementQueues).map((e) => e.source).sort();
    expect(intoQueues).toEqual([N.settlements!, N.stores!].sort());
  });

  it('connects token validation to CreatePool rather than the proposal choice', () => {
    const validation = render('contracts').edges.find((e) => e.id === 'factory-token-standard');
    expect(validation?.sourceHandle).toBe('choice-PoolFactory_CreatePool-out');
    expect(validation?.target).toBe('external.token-standard');
  });

  it('attributes the trader authorization checks to the delegation, with no request-to-settlement call', () => {
    const graph = render('contracts');
    expect(graph.edges.find((e) => e.id === 'delegation-kyc')?.target).toBe(N.kyc);
    expect(graph.edges.find((e) => e.id === 'delegation-access')?.target).toBe(N.access);
    expect(graph.edges.some((e) => e.source === N.access && e.target === N.delegation)).toBe(false);
  });
});

describe('system overview roles', () => {
  const frontendOf = (graph: Built) => graph.nodes.find((n) => n.data.kind === 'layer' && n.data.layerId === 'frontend')!;

  it('shows Trader and Operator as separate boxes in the Frontend, and only the Trader signs', () => {
    const graph = render();
    const frontend = frontendOf(graph);
    expect(inside(frontend, nodeOf(graph, 'band-browser'))).toBe(true);
    // Behind its roles and wires, yet it still takes the click that opens the Frontend layer.
    expect(frontend.zIndex).toBe(-1);
    expect(frontend.selectable).toBe(false);
    expect(frontend.style?.pointerEvents).toBe('all');
    for (const [id, label] of [[N.trader!, 'Trader'], [N.operator!, 'Operator']] as const) {
      const role = nodeOf(graph, id);
      expect(role.data.label).toBe(label);
      expect(role.data.entityId, 'hover documentation').toBe(id);
      expect(inside(role, frontend), `${label} inside Frontend`).toBe(true);
      expect(graph.edges.filter((e) => e.source === id).map((e) => e.target), label).toEqual(['layer-client']);
    }
    const wallet = graph.edges.filter((e) => e.source === N.externalWallet || e.target === N.externalWallet);
    expect(wallet.map((e) => [e.source, e.target])).toEqual([[N.externalWallet, N.trader]]);
    expect(graph.edges.find((e) => e.source === N.keycloak)?.target, 'login covers both roles').toBe(frontend.id);
  });

  it('places every system box without overlaps', () => {
    const boxes = render().nodes.filter((n) => n.data.kind !== 'boundary' && n.zIndex !== -1);
    for (const [index, a] of boxes.entries()) {
      for (const b of boxes.slice(index + 1)) {
        const apart = a.position.x + a.width! <= b.position.x || b.position.x + b.width! <= a.position.x
          || a.position.y + a.height! <= b.position.y || b.position.y + b.height! <= a.position.y;
        expect(apart, `${a.id} overlaps ${b.id}`).toBe(true);
      }
    }
  });
});

describe('database access through the backend client', () => {
  it('routes backend persistence through the database client to the external PostgreSQL', () => {
    const system = render();
    expect(system.edges.filter((e) => e.target === N.database).map((e) => e.source)).toEqual([N.dbClient]);
    expect(system.edges.some((e) => e.source === N.stores && e.target === N.dbClient)).toBe(true);
    expect(inside(nodeOf(system, N.dbClient!), nodeOf(system, 'band-backend'))).toBe(true);
    expect(inside(nodeOf(system, N.database!), nodeOf(system, 'band-backend'))).toBe(false);

    const backend = backendGraph();
    for (const id of [N.stores!, N.iam!, N.operations!, N.settlementQueues!]) {
      expect(backend.edges.some((e) => e.source === id && e.target === N.dbClient), id).toBe(true);
    }
    const drawn = render('backend');
    expect(inside(nodeOf(drawn, N.dbClient!), nodeOf(drawn, 'backend-boundary'))).toBe(true);
    expect(backend.edges.some((e) => e.source === N.settlementQueues && e.target === N.dbClient), 'queues are PostgreSQL rows').toBe(true);
    expect(backend.edges.filter((e) => e.target === N.database).map((e) => e.source)).toEqual([N.dbClient]);
  });
});
