import { Button } from '@openzeppelin/ui-components';
import { Fragment, useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';
import { Background, BaseEdge, EdgeLabelRenderer, Handle, Position, ReactFlow, ReactFlowProvider,
  useReactFlow, useStore, useViewport, type EdgeProps, type NodeProps } from '@xyflow/react';
import type { DamlFlow } from './catalog';
import { edgeGeometry, makeGraph, type FlowEdge, type FlowGraph, type GroupNode, type LaneData, type StepData } from './graph';
import type { FlowDocument } from './source';
import './flows.css';

const PORTS = [
  ['top-in', 'target', Position.Top], ['bottom-out', 'source', Position.Bottom],
  ['right-in', 'target', Position.Right], ['right-out', 'source', Position.Right],
  ['left-out', 'source', Position.Left],
] as const;
const BADGES: Record<string, string> = { exercise: 'Exercise', create: 'Create', archive: 'Archive',
  check: 'Check', decision: 'Decision', loop: 'For each', activity: 'Action' };
const MIN_ZOOM = 0.01;
const MAX_ZOOM = 1.8;
const READING_ZOOM = 0.75;
const VIEW_PADDING = 24;
const ZOOM_STEP = 1.2;
const EXTENT_MARGIN = 64;
/** The verb a badge already names, dropped only where a named contract follows it. */
const BADGE_VERB = /^(Exercise|Create|Archive) (?=(?:[a-z]+ )?\*\*)/;
const LEGEND = ['exercise', 'create', 'archive', 'check', 'activity', 'decision', 'loop'] as const;
const OFF_LEDGER = 'Off-ledger';

function RichText({ text }: { text: string }) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => {
    if (!part.startsWith('**')) return <Fragment key={i}>{part}</Fragment>;
    return <strong key={i}>{part.slice(2, -2).split(/(?<=_)|(?<=[a-z])(?=[A-Z])/).map((word, j) =>
      <Fragment key={j}>{j > 0 && <wbr />}{word}</Fragment>)}</strong>;
  });
}
function Step({ data }: { data: StepData }) {
  const terminal = data.kind === 'start' || data.kind === 'stop';
  const label = ['exercise', 'create', 'archive'].includes(data.kind) ? data.label.replace(BADGE_VERB, '') : data.label;
  return (
    <div className={`flow-step flow-step--${data.kind}${data.offLedger ? ' flow-step--off-ledger' : ''}`}
      role={data.offLedger ? 'group' : undefined} aria-label={data.offLedger ? OFF_LEDGER : undefined}>
      {PORTS.map(([id, type, position]) => <Handle key={id} id={id} type={type} position={position} isConnectable={false} />)}
      {terminal ? <span className="terminal-label">{data.kind === 'start' ? 'Start' : 'End'}</span> : <>
        <div className="step-meta">
          <span className="step-kind"><i />{BADGES[data.kind]}</span>
          <span className="step-number">{String(data.number).padStart(2, '0')}</span>
        </div>
        <div className="step-label"><RichText text={label} /></div>
      </>}
    </div>
  );
}
function LaneTitle({ label }: { label: string }) {
  const [name, detail] = label.replace(/ · off-ledger\b/i, '').split('\n');
  return <div><strong>{name}</strong>{detail && <span>{detail}</span>}</div>;
}
function Lane() { return <div className="flow-lane" />; }
function Group({ data }: NodeProps<GroupNode>) {
  return <div className="flow-group" role="group" aria-label={data.label.replaceAll('\n', ' ')}>
    <div className="flow-group-label">{data.label}</div>
  </div>;
}
function Wire({ id, data, markerEnd }: EdgeProps<FlowEdge>) {
  if (!data) return null;
  const { path, label, labelAtTarget } = edgeGeometry(data);
  return <>
    <BaseEdge id={id} path={path} markerEnd={markerEnd} style={{ stroke: 'var(--flow-wire)', strokeWidth: 1.35 }} />
    {data.label && <EdgeLabelRenderer>
      <div className="wire-label"
        style={{ transform: `translate(${labelAtTarget ? '8px' : '-50%'}, -50%) translate(${label[0]}px, ${label[1]}px)` }}>
        {data.label}
      </div>
    </EdgeLabelRenderer>}
  </>;
}
const NODE_TYPES = { step: Step, lane: Lane, region: Group };
const EDGE_TYPES = { flow: Wire };

/** The view the pan limits allow: centred when the diagram fits, otherwise within its margins. */
function clampView(x: number, y: number, zoom: number, graph: FlowGraph, area: HTMLDivElement) {
  const margin = EXTENT_MARGIN * zoom;
  const fit = (offset: number, size: number, room: number) => (size * zoom + margin * 2 <= room
    ? (room - size * zoom) / 2 : Math.min(margin, Math.max(room - margin - size * zoom, offset)));
  return { x: fit(x, graph.width, area.clientWidth), y: fit(y, graph.height, area.clientHeight) };
}

function ViewTools({ graph, canvas }: { graph: FlowGraph; canvas: RefObject<HTMLDivElement | null> }) {
  const { setViewport, getViewport, viewportInitialized } = useReactFlow();
  const zoom = useStore((state) => state.transform[2]);
  const fit = useCallback(() => {
    const area = canvas.current;
    if (!area || area.clientWidth <= VIEW_PADDING * 2) return;
    const scale = Math.max(MIN_ZOOM, Math.min(1,
      (area.clientWidth - VIEW_PADDING * 2) / graph.width));
    void setViewport({ x: (area.clientWidth - graph.width * scale) / 2,
      y: VIEW_PADDING, zoom: scale });
  }, [canvas, graph, setViewport]);
  const readable = useCallback(() => {
    const area = canvas.current;
    if (!area?.clientWidth) return;
    const scale = Math.max(READING_ZOOM, Math.min(1, (area.clientWidth - VIEW_PADDING * 2) / graph.width));
    void setViewport({ x: Math.max(VIEW_PADDING, (area.clientWidth - graph.width * scale) / 2), y: VIEW_PADDING, zoom: scale });
  }, [canvas, graph, setViewport]);
  const zoomBy = useCallback((factor: number) => {
    const area = canvas.current;
    if (!area?.clientWidth) return;
    const view = getViewport();
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom * factor));
    const anchor = area.clientWidth / 2;
    const x = anchor - ((anchor - view.x) / view.zoom) * next, y = (view.y / view.zoom) * next;
    void setViewport({ ...clampView(x, y, next, graph, area), zoom: next });
  }, [canvas, getViewport, graph, setViewport]);
  useEffect(() => {
    if (!viewportInitialized || !canvas.current) return;
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(canvas.current);
    return () => observer.disconnect();
  }, [viewportInitialized, canvas, fit]);
  return <div className="flow-tools" role="toolbar" aria-label="Diagram view">
    <Button size="sm" variant="secondary" onClick={readable}>Reading view</Button>
    <Button size="sm" variant="ghost" aria-label="Zoom out" onClick={() => zoomBy(1 / ZOOM_STEP)}>−</Button>
    <span className="zoom-value">{Math.round(zoom * 100)}%</span>
    <Button size="sm" variant="ghost" aria-label="Zoom in" onClick={() => zoomBy(ZOOM_STEP)}>+</Button>
    <span className="canvas-instruction">Drag to pan · scroll to zoom</span>
  </div>;
}

function LaneHeaders({ lanes }: { lanes: LaneData[] }) {
  const { x, zoom } = useViewport();
  return <div className="flow-lane-headers">
    {lanes.map((lane) => <header key={lane.index} style={{ left: x + lane.x * zoom, width: lane.width * zoom }}
      className={lane.offLedger ? 'flow-header--off-ledger' : undefined}
      aria-label={lane.offLedger ? OFF_LEDGER : undefined}>
      <LaneTitle label={lane.label} />
    </header>)}
  </div>;
}

/** Native cards and read-only top-down swim lanes, sharing the app's CSS theme. */
export function Diagram({ flow, document }: { flow: DamlFlow; document: FlowDocument }) {
  const graph = useMemo(() => makeGraph(document), [document]);
  const canvas = useRef<HTMLDivElement>(null);
  const lanes = useMemo(() => graph.nodes.flatMap((node) => (node.type === 'lane' ? [node.data] : [])), [graph]);
  const kinds = useMemo(() => new Set(graph.nodes.flatMap((node) => (node.type === 'step' ? [node.data.kind] : []))), [graph]);
  const hasOffLedger = graph.nodes.some(node => (node.type === 'step' || node.type === 'lane') && node.data.offLedger);
  const extent = useMemo<[[number, number], [number, number]]>(() => [[-EXTENT_MARGIN, -EXTENT_MARGIN],
    [graph.width + EXTENT_MARGIN, graph.height + EXTENT_MARGIN]], [graph]);
  return <>
    <section className="flow-shell" aria-label={`${flow.title} diagram`}>
      <ReactFlowProvider>
        <ViewTools graph={graph} canvas={canvas} />
        <LaneHeaders lanes={lanes} />
        <div className="flow-canvas" ref={canvas}>
          <div className="absolute inset-0">
            <ReactFlow nodes={graph.nodes} edges={graph.edges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES}
              nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} elementsSelectable={false}
              minZoom={MIN_ZOOM} maxZoom={MAX_ZOOM} translateExtent={extent}
              zoomOnScroll zoomOnPinch
              panOnDrag preventScrolling deleteKeyCode={null}>
              <Background gap={22} size={1} color="var(--border)" />
            </ReactFlow>
          </div>
        </div>
      </ReactFlowProvider>
    </section>
    <footer className="flow-footer"><span>{graph.count} steps</span>
      <span className="flow-legend">{LEGEND.filter((kind) => kinds.has(kind)).map((kind) =>
        <Fragment key={kind}><i className={`legend-${kind}`} />{BADGES[kind]}</Fragment>)}
        {hasOffLedger && <><i className="legend-off-ledger" />{OFF_LEDGER}</>}</span>
    </footer>
  </>;
}
