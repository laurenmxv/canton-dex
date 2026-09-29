import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Background, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { Button, TooltipProvider } from '@openzeppelin/ui-components';
import { isArchitectureHash } from '../routes';
import { layerIds, readRoute, routeHash, viewSummary } from './content';
import { DiagramContext } from './diagram-context';
import { buildGraph } from './graph';
import { AtlasEdge, AtlasNode } from './renderers';
import { withRoutes, type Bounds } from './routing';
import { useRoutes } from './useRoutes';

const nodeTypes = { atlas: AtlasNode };
const edgeTypes = { atlasEdge: AtlasEdge };
const minZoom = 0.2;
const fitOptions = { padding: 0.06 };
/** Longest wait for a view's routed wires before its authored wires show instead. */
const ROUTE_WAIT_MS = 1000;
/** The route ids stay stable for links; the visible names come from the model. */
const views = ['system', ...layerIds].map((id) => [id, viewSummary(id).name] as const);

/** The view the URL names. Any other parameter, such as an old flow link's, is dropped from the URL. */
function useView(): string {
  const [view, setView] = useState(() => readRoute().view);
  useEffect(() => {
    const sync = () => {
      const { hash, pathname, search } = window.location;
      if (!isArchitectureHash(hash)) return;
      const next = readRoute(hash).view;
      const canonical = routeHash({ view: next });
      if (hash !== canonical) window.history.replaceState(null, '', pathname + search + canonical);
      setView(next);
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  return view;
}

/** `heading` names the page in the toolbar row, which leaves the diagram more height. */
export function Atlas({ heading }: { heading?: ReactNode }) {
  const view = useView();
  const open = useCallback((next: string) => { window.location.hash = routeHash({ view: next }); }, []);
  const graph = useMemo(() => buildGraph(view), [view]);
  const routes = useRoutes(graph.authored ? null : view);
  const edges = useMemo(() => graph.authored ? graph.edges : withRoutes(graph.edges, routes), [graph, routes]);
  const bounds = useMemo<Bounds>(() => (graph.authored ? null : routes?.bounds) ?? { x: 0, y: 0, width: graph.width, height: graph.height },
    [graph, routes]);
  const context = useMemo(() => ({ onLayer: open }), [open]);

  return (
    <DiagramContext.Provider value={context}>
      <TooltipProvider delayDuration={150} skipDelayDuration={400} disableHoverableContent>
        <div className="atlas" data-view={view}>
          <header className="atlas-header">
            {heading}
            <nav className="atlas-nav" aria-label="Layers">
              {views.map(([id, label]) => (
                <Button key={id} size="sm" variant={view === id ? 'default' : 'ghost'}
                  aria-current={view === id ? 'page' : undefined} onClick={() => open(id)}>{label}</Button>
              ))}
            </nav>
            <p className="atlas-summary">{viewSummary(view).short}</p>
          </header>
          <div className="atlas-body">
            <section className="atlas-canvas" aria-label="Architecture diagram">
              <ReactFlowProvider key={view}>
                <div className="atlas-canvas-toolbar">
                  <Toolbar bounds={bounds} />
                </div>
                <Stage ready={graph.authored === true || routes !== null}>
                  <ReactFlow nodes={graph.nodes} edges={edges}
                    nodeTypes={nodeTypes} edgeTypes={edgeTypes}
                    nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false}
                    deleteKeyCode={null} zoomOnScroll preventScrolling panOnDrag
                    minZoom={minZoom} maxZoom={1.5}>
                    <Background gap={24} color="var(--border)" />
                  </ReactFlow>
                </Stage>
              </ReactFlowProvider>
            </section>
          </div>
        </div>
      </TooltipProvider>
    </DiagramContext.Provider>
  );
}

/**
 * A view's diagram fades in once its own wires are ready, so a layer change never shows another
 * view's diagram or wires that are about to move. It is new for each view, with the view's provider.
 */
function Stage({ ready, children }: { ready: boolean; children: ReactNode }) {
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setWaited(true), ROUTE_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return <div className={`atlas-stage${ready || waited ? ' is-shown' : ''}`}>{children}</div>;
}

function Toolbar({ bounds }: { bounds: Bounds }) {
  const { fitBounds, zoomIn, zoomOut, viewportInitialized } = useReactFlow();
  // The extent covers the boxes, the wire corridors and their labels.
  const fit = useCallback(() => void fitBounds(bounds, fitOptions), [fitBounds, bounds]);
  useEffect(() => { if (viewportInitialized) fit(); }, [viewportInitialized, fit]);
  return (
    <div className="atlas-toolbar" role="toolbar" aria-label="Diagram view">
      <Button size="sm" variant="secondary" onClick={fit}>Show all</Button>
      <Button size="sm" variant="secondary" aria-label="Zoom in" onClick={() => void zoomIn()}>+</Button>
      <Button size="sm" variant="secondary" aria-label="Zoom out" onClick={() => void zoomOut()}>−</Button>
    </div>
  );
}
