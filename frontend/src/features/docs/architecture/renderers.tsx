import { useContext, type ReactNode } from 'react';
import {
  BaseEdge, EdgeLabelRenderer, Handle, Position, getSmoothStepPath,
  type Edge, type EdgeProps, type Node, type NodeProps,
} from '@xyflow/react';
import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@openzeppelin/ui-components';
import { Card } from '../../../ui/Card';
import { model } from './content';
import type { DiagramEdgeData, DiagramNodeData } from './content';
import { CANTON_ICON, choiceRowCenter } from './graph-base';
import { routePath } from './routing';
import { DiagramContext } from './diagram-context';
import cantonSymbolBlack from './brand/canton-symbol-black.svg';
import cantonSymbolWhite from './brand/canton-symbol-white.svg';

const NO_DRAG_CLASS = 'nodrag';
const NO_PAN_CLASS = 'nopan';
const KINDS = { boundary: 'boundary', layer: 'layer', template: 'template', context: 'context' } as const;
const handles = [
  { id: 'in', type: 'target', position: Position.Left },
  { id: 'out', type: 'source', position: Position.Right },
  { id: 'top-in', type: 'target', position: Position.Top },
  { id: 'top-out', type: 'source', position: Position.Top },
  { id: 'bottom-in', type: 'target', position: Position.Bottom },
  { id: 'bottom-out', type: 'source', position: Position.Bottom },
  { id: 'right-in', type: 'target', position: Position.Right },
  { id: 'left-out', type: 'source', position: Position.Left },
] as const;
const ports = handles.map((handle) => <Handle key={handle.id} {...handle} isConnectable={false} className="atlas-port" />);

const glyphs: Record<string, string> = {
  browser: 'M3 4h18v16H3z M3 8h18 M6 6h.01 M9 6h.01',
  code: 'm8 5-6 7 6 7 M16 5l6 7-6 7 M14 3l-4 18',
  database: 'M3 5c0-4 18-4 18 0s-18 4-18 0v14c0 4 18 4 18 0V5 M3 12c0 4 18 4 18 0',
  key: 'M14 3a7 7 0 1 1-5 12l-6 6H1v-4l7-7a7 7 0 0 1 6-7Z M16 7h.01',
  document: 'M5 2h9l5 5v15H5z M14 2v6h5 M8 12h8 M8 16h8',
  server: 'M3 3h18v7H3z M3 14h18v7H3z M6 6h.01 M6 17h.01 M10 6h8 M10 17h8',
  network: 'M10 2h4v4h-4z M2 18h4v4H2z M18 18h4v4h-4z M12 6v6 M4 18v-6h16v6',
  identity: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z M3 22v-3a9 9 0 0 1 18 0v3',
  workflow: 'M3 3h7v7H3z M14 14h7v7h-7z M10 6h7v8 M3 17h7 M7 14l3 3-3 3',
};

function Glyph({ data }: { data: DiagramNodeData }) {
  // The official Canton symbol, in the variant the brand kit gives for each theme.
  if (data.icon === CANTON_ICON) {
    return <span className="atlas-glyph atlas-brand" aria-hidden="true">
      <img className="atlas-brand-light" src={cantonSymbolBlack} alt="" />
      <img className="atlas-brand-dark" src={cantonSymbolWhite} alt="" />
    </span>;
  }
  const identity = data.entityId ?? data.layerId ?? '';
  const fallback = /wallet/.test(identity) ? 'key'
    : /keycloak|party-hosting/.test(identity) ? 'identity'
    : /stores|postgres|state/.test(identity) ? 'database'
      : /frontend/.test(identity) ? 'browser'
        : /client/.test(identity) ? 'code'
          : /contracts/.test(identity) ? 'document'
            : /canton/.test(identity) ? 'network'
              : data.kind === KINDS.layer ? 'server' : 'workflow';
  return <svg className="atlas-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={glyphs[data.icon ?? ''] ?? glyphs[fallback]} />
  </svg>;
}

function Facts({ items }: { items: [string, string | undefined][] }) {
  const shown = items.filter(([, value]) => Boolean(value));
  if (!shown.length) return null;
  return <dl className="atlas-tip-facts">{shown.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>;
}

function NodeTip({ label, purpose, note, source, facts = [] }: {
  label: string; purpose?: string; note?: string; source?: string; facts?: [string, string | undefined][];
}) {
  return <>
    <strong className="atlas-tip-title">{label}</strong>
    {purpose ? <p>{purpose}</p> : null}
    <Facts items={facts} />
    {note ? <p className="atlas-tip-note">{note}</p> : null}
    {source ? <code className="atlas-tip-source">{source}</code> : null}
  </>;
}

/** A detail row that explains itself on hover or keyboard focus. */
function Explained({ children, tip }: { children: ReactNode; tip: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className="atlas-tip" side="right" align="start" sideOffset={10} collisionPadding={12}>{tip}</TooltipContent>
    </Tooltip>
  );
}

export function AtlasNode({ data }: NodeProps<Node<DiagramNodeData>>) {
  const { onLayer } = useContext(DiagramContext);
  const classes = ['atlas-node', `atlas-node--${data.kind}`].join(' ');

  if (data.kind === KINDS.boundary) {
    // Ports let an authored wire end on a group's border.
    return <div className={classes} aria-label={data.label}>{ports}<span>{data.label}</span></div>;
  }

  const entity = data.entityId ? model.nodes[data.entityId] : undefined;
  // External dependencies and separate tools, as the model marks them.
  const external = entity?.external === true;
  const navigable = data.kind === KINDS.layer && Boolean(data.layerId);
  // A context box without an entity still explains its layer on hover.
  const layer = data.layerId && (navigable || !entity) ? model.layers[data.layerId] : undefined;
  const documentation = entity?.documentation;
  const purpose = entity?.purpose ?? layer?.purpose;
  const note = entity?.note ?? layer?.note;
  const explained = Boolean(purpose || note);
  // A box a view names differently keeps that name in its tip and says which module the text documents.
  const renamed = Boolean(entity) && data.kind !== KINDS.template && data.label !== entity?.title;
  const tip = (
    <TooltipContent className="atlas-tip" side="right" align="start" sideOffset={10} collisionPadding={12}>
      <NodeTip label={renamed ? data.label : entity?.title ?? layer?.name ?? data.label} purpose={purpose} note={note}
        source={documentation ? `${documentation.path}:${documentation.line}` : entity?.source}
        facts={[['Documented as', renamed ? entity?.title : undefined],
          ['Template', entity?.exact], ['Signatories', entity?.signs], ['Observers', entity?.sees]]} />
    </TooltipContent>
  );
  // A box with choice rows explains itself from its heading only, so a row's own tip never opens it too.
  const rows = Boolean(data.choices?.length);
  const heading = (
    <div className="atlas-node-heading">
      <Glyph data={data} />
      {navigable ? (
        <Button size="sm" variant="ghost" className={`atlas-node-title ${NO_DRAG_CLASS} ${NO_PAN_CLASS}`} onClick={() => onLayer(data.layerId!)}>
          {data.label}
        </Button>
      ) : (
        // Focusable, so the explanation opens from the keyboard as it does on hover.
        <span className="atlas-node-title atlas-node-title--static" tabIndex={explained ? 0 : undefined}>{data.label}</span>
      )}
    </div>
  );
  const card = (
    <Card className={[classes, external && 'atlas-node--external', data.icon === CANTON_ICON && 'atlas-node--canton']
      .filter(Boolean).join(' ')} role="group" aria-label={data.label}>
      {ports}
      {explained && rows ? <Tooltip><TooltipTrigger asChild>{heading}</TooltipTrigger>{tip}</Tooltip> : heading}
      {data.choices?.length ? <ul className="atlas-choices">{data.choices.map((choice, index) => {
        const top = choiceRowCenter(index);
        const details = model.choices[choice.id];
        return <li key={choice.id} className="atlas-choice-row">
          <Handle type="target" position={Position.Left} id={`choice-${choice.id}-in`}
            isConnectable={false} className="atlas-port atlas-choice-port" style={{ top }} />
          <Explained tip={<NodeTip label={choice.label} source={details?.source} facts={[
            ['Choice', choice.id], ['Controller', choice.controller],
            ['Archives the contract', details ? (details.consuming ? 'Yes' : 'No') : undefined],
          ]} />}>
            <span className={`atlas-choice ${NO_DRAG_CLASS}${details?.consuming === false ? ' atlas-choice--kept' : ''}`} tabIndex={0}>{choice.label}</span>
          </Explained>
          <Handle type="source" position={Position.Right} id={`choice-${choice.id}-out`}
            isConnectable={false} className="atlas-port atlas-choice-port" style={{ top }} />
        </li>;
      })}</ul> : null}
      {data.chips?.length ? <div className="atlas-node-chips">{data.chips.map((chip) => <span key={chip}>{chip}</span>)}</div> : null}
    </Card>
  );
  if (!explained || rows) return card;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="atlas-node-frame">{card}</div>
      </TooltipTrigger>
      {tip}
    </Tooltip>
  );
}

type Point = { x: number; y: number };

function orthogonalPoints(start: Point, via: Point[], end: Point, source: Position, target: Position): Point[] {
  const points = [start];
  const stops = [...via, end];
  for (let index = 0; index < stops.length; index++) {
    const next = stops[index]!;
    const previous = points[points.length - 1]!;
    if (previous.x !== next.x && previous.y !== next.y) {
      const isLast = index === stops.length - 1;
      const horizontalFirst = isLast
        ? target === Position.Top || target === Position.Bottom
        : index === 0 ? source === Position.Left || source === Position.Right : true;
      points.push(horizontalFirst ? { x: next.x, y: previous.y } : { x: previous.x, y: next.y });
    }
    if (previous.x !== next.x || previous.y !== next.y) points.push(next);
  }
  return points;
}

function pathCenter(points: Point[]): Point {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!; const b = points[i]!;
    length += Math.hypot(b.x - a.x, b.y - a.y);
  }
  let remaining = length / 2;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!; const b = points[i]!;
    const segment = Math.hypot(b.x - a.x, b.y - a.y);
    if (segment > 0 && remaining <= segment) {
      const ratio = remaining / segment;
      return { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio };
    }
    remaining -= segment;
  }
  return points[0]!;
}

export function AtlasEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  markerEnd, style, label, data }: EdgeProps<Edge<DiagramEdgeData>>) {
  let path: string; let labelX: number; let labelY: number;
  if (data?.route) {
    // Routed geometry is absolute; the handle positions only anchor the authored fallback.
    path = routePath(data.route.points, data.hops);
    labelX = data.route.label.x; labelY = data.route.label.y;
  } else if (data?.via?.length) {
    const points = orthogonalPoints({ x: sourceX, y: sourceY }, data.via,
      { x: targetX, y: targetY }, sourcePosition, targetPosition);
    path = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`).join(' ');
    const center = pathCenter(points);
    labelX = center.x; labelY = center.y;
  } else {
    [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY,
      sourcePosition, targetPosition, borderRadius: 6, offset: 20 });
  }
  const edgeClass = ['atlas-edge', data?.structural && 'atlas-edge--structural'].filter(Boolean).join(' ');
  const labelClass = ['atlas-edge-label', NO_DRAG_CLASS, NO_PAN_CLASS].join(' ');
  return <>
    <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} className={edgeClass} />
    {label ? <EdgeLabelRenderer>
      <div className={labelClass} title={data?.summary} style={{ ...(data?.summary ? { pointerEvents: 'all', cursor: 'help' } : {}), transform: `translate(-50%, -50%) translate(${data?.route ? labelX : data?.labelAt?.x ?? labelX}px, ${data?.route ? labelY : data?.labelAt?.y ?? labelY}px)` }}>{label}</div>
    </EdgeLabelRenderer> : null}
  </>;
}
