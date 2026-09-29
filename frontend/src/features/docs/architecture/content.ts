import { ARCHITECTURE_HASH_PREFIX } from '../routes';
import rawModel from './model.generated.json';

export interface Entity {
  id: string; layer: string; title: string; purpose: string; chips: string[]; source: string;
  exact?: string; signs?: string; sees?: string; choices?: string[]; note?: string;
  external?: boolean; worker?: boolean;
  documentation?: { format: 'TSDoc'; path: string; line: number };
}
export interface Choice {
  id: string; owner: string; label: string; controller: string; source: string; consuming: boolean;
}
export interface Layer {
  name: string; number: string; tag: string; purpose: string; short: string;
  nodes: string[]; context: string[]; boundary: string; note: string;
}
/** A view's name and its one-line responsibility and stack. */
export interface ViewSummary { name: string; short: string }
export interface Model {
  N: Record<string, string>; C: Record<string, string>;
  nodes: Record<string, Entity>; choices: Record<string, Choice>; layers: Record<string, Layer>;
  overview: ViewSummary;
  baseline: string; sourceRoot: string;
}
export const model = rawModel as unknown as Model;
/** Layers with a drill-down view. Canton stays a model layer and shows as All Layers context. */
export const layerIds = ['frontend', 'client', 'backend', 'contracts'] as const;
const views: readonly string[] = layerIds;
/** What the Atlas shows: one structural view. Flows live on the Daml flows page. */
export interface AtlasState { view: string }
export const initialState: AtlasState = { view: 'system' };
/** Reads the view from the URL. Any other parameter, such as an old flow link's, is ignored. */
export function readRoute(hash = window.location.hash): AtlasState {
  const route = hash.startsWith(ARCHITECTURE_HASH_PREFIX) ? hash.slice(ARCHITECTURE_HASH_PREFIX.length) : '';
  const [path] = route.split('?');
  return { view: path && views.includes(path) ? path : 'system' };
}
export function routeHash(state: AtlasState): string {
  return `${ARCHITECTURE_HASH_PREFIX}${state.view}`;
}
/** The name and one-line summary of a view: the All Layers overview, or one layer. */
export function viewSummary(view: string): ViewSummary {
  return view === initialState.view ? model.overview : model.layers[view] ?? model.overview;
}
export function sourceUrl(source: string): string {
  const match = /^(.*?):(\d+)$/.exec(source);
  return `${model.sourceRoot}${match?.[1] ?? source}${match ? `#L${match[2]}` : ''}`;
}

// Graph layouts describe the source-reviewed structure through these display types.
export interface ChoiceDisplay { id: string; label: string; controller: string }
export interface DiagramNodeData extends Record<string, unknown> {
  label: string; kind: 'layer' | 'block' | 'template' | 'context' | 'boundary';
  entityId?: string; layerId?: string; icon?: string;
  chips?: string[]; choices?: ChoiceDisplay[]; subtitle?: string;
}
export interface DiagramEdgeData extends Record<string, unknown> {
  structural?: boolean;
  via?: { x: number; y: number }[]; labelAt?: { x: number; y: number };
  /** Routed geometry; without it the authored `via` and `labelAt` draw the wire. */
  route?: { points: { x: number; y: number }[]; label: { x: number; y: number } };
  hops?: { x: number; y: number }[];
  /** An aggregate wire: the IDs of the relations it draws once, and their plain summary. */
  members?: string[]; summary?: string;
}
