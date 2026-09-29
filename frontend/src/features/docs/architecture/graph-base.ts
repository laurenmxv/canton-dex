import { MarkerType, type Edge, type Node } from '@xyflow/react';
import { model, type ChoiceDisplay, type DiagramEdgeData, type DiagramNodeData } from './content';

/** `authored` graphs carry their own wire geometry, so the router leaves them as drawn. */
export interface Graph { nodes: Node<DiagramNodeData>[]; edges: Edge<DiagramEdgeData>[]; width: number; height: number; authored?: boolean }
export interface NodeSpec {
  kind?: DiagramNodeData['kind']; label?: string; width?: number; height?: number; layerId?: string;
  entityId?: string; chips?: string[]; icon?: string; subtitle?: string;
  /**
   * A box that holds other boxes: it stays behind them and their wires, and a click cannot raise it.
   * React Flow drops pointer input on a node that is neither selectable nor draggable, so the
   * container restores it for its own title.
   */
  container?: boolean;
  /** A top-level band of the All Layers view, whose caption is larger than a group's. */
  band?: boolean;
  /** Draws the box in the external-service palette in this view only; the model's semantics do not change. */
  amber?: boolean;
}
export interface EdgeSpec {
  sourceHandle?: string; targetHandle?: string; structural?: boolean;
  via?: { x: number; y: number }[]; labelAt?: { x: number; y: number };
}

const STROKE = '#64748b';

/** Template geometry shared by the node renderer and the router: title row, then one row per choice. */
export const TITLE_HEIGHT = 58;
export const CHOICE_HEIGHT = 32;
/** Distance from a template's top edge to the centre of its choice row `index`. */
/** The class of an All Layers band. Its caption style in nodes.css and the router's caption extent agree. */
export const BAND_CLASS = 'atlas-band';
export const AMBER_CLASS = 'atlas-amber';
export const CANTON_ICON = 'canton';
export const CAPTION = { charWidth: 7.5, bottom: 30 };
export const BAND_CAPTION = { charWidth: 8.8, bottom: 33 };
export const choiceRowCenter = (index: number) => TITLE_HEIGHT + CHOICE_HEIGHT / 2 + CHOICE_HEIGHT * index;

function defaultSize(kind: DiagramNodeData['kind'], choices: number): { width: number; height: number } {
  if (kind === 'template') return { width: 240, height: 68 + 32 * choices };
  if (kind === 'context') return { width: 220, height: 82 };
  return { width: 220, height: 96 };
}

export function canvas(width: number, height: number): {
  graph: Graph;
  node: (id: string, x: number, y: number, options?: NodeSpec) => void;
  edge: (id: string, source: string, target: string, label: string, options?: EdgeSpec) => void;
} {
  const graph: Graph = { nodes: [], edges: [], width, height };

  const node = (id: string, x: number, y: number, options: NodeSpec = {}) => {
    const entityId = options.entityId ?? (model.nodes[id] ? id : undefined);
    const entity = entityId ? model.nodes[entityId] : undefined;
    const kind = options.kind ?? (entity?.choices ? 'template' : entity?.external ? 'context' : 'block');
    const choices: ChoiceDisplay[] | undefined = kind === 'template'
      ? (entity?.choices ?? []).map((choice) => ({
        id: choice, label: model.choices[choice]?.label ?? choice, controller: model.choices[choice]?.controller ?? '',
      }))
      : undefined;
    const size = defaultSize(kind, choices?.length ?? 0);
    const { layerId } = options;
    graph.nodes.push({
      id, type: 'atlas', position: { x, y },
      width: options.width ?? size.width, height: options.height ?? size.height, draggable: false,
      ...(kind === 'boundary' ? { zIndex: -1, selectable: false, focusable: false }
        : options.container ? { zIndex: -1, selectable: false, style: { pointerEvents: 'all' as const } } : {}),
      ...(options.band || options.amber ? { className: [options.band && BAND_CLASS, options.amber && AMBER_CLASS].filter(Boolean).join(' ') } : {}),
      data: {
        label: options.label ?? entity?.title ?? (layerId ? model.layers[layerId]?.name : undefined) ?? id,
        kind, entityId, layerId, icon: options.icon, chips: options.chips, choices, subtitle: options.subtitle,
      },
    });
  };

  const edge = (id: string, source: string, target: string, label: string, options: EdgeSpec = {}) => {
    graph.edges.push({
      id, source, target, label, type: 'atlasEdge',
      sourceHandle: options.sourceHandle ?? 'out', targetHandle: options.targetHandle ?? 'in',
      ...(options.structural ? {} : { markerEnd: { type: MarkerType.ArrowClosed, color: STROKE, width: 16, height: 16 } }),
      style: { stroke: STROKE, strokeWidth: 1.8, ...(options.structural ? { strokeDasharray: '5 4' } : {}) },
      data: { structural: options.structural ?? false, via: options.via, labelAt: options.labelAt },
    });
  };

  return { graph, node, edge };
}
