import { AvoidLib } from 'libavoid-js';
import { useEffect, useState } from 'react';
import { routeStructure, structureOf, type AvoidApi, type RouteTable } from './routing';

// The package exports no subpath, so the WebAssembly file is referenced as an asset of this module.
const wasm = new URL('../../../../node_modules/libavoid-js/dist/libavoid.wasm', import.meta.url);

let loading: Promise<AvoidApi> | undefined;
let warned = false;
const tables = new Map<string, RouteTable>();

/** Loads libavoid once per page. A failed load may be tried again by the next view. */
export function loadAvoid(): Promise<AvoidApi> {
  loading ??= AvoidLib.load(wasm.protocol === 'file:' ? decodeURIComponent(wasm.pathname) : wasm.href)
    .then(() => AvoidLib.getInstance() as unknown as AvoidApi)
    .catch((error: unknown) => {
      loading = undefined;
      throw error;
    });
  return loading;
}

/**
 * The routed geometry for a view, or null while libavoid loads or if it fails. Null keeps
 * the authored wires, so the diagram never renders without connections. A null view is not routed.
 */
export function useRoutes(view: string | null): RouteTable | null {
  // The table is kept with its view, so a render after a view change never shows the last view's wires.
  const [held, setHeld] = useState<{ view: string | null; table: RouteTable | null }>(
    () => ({ view, table: view === null ? null : tables.get(view) ?? null }));
  useEffect(() => {
    const cached = view === null ? undefined : tables.get(view);
    setHeld({ view, table: cached ?? null });
    if (cached || view === null) return;
    let live = true;
    loadAvoid()
      .then((avoid) => {
        const routed = tables.get(view) ?? routeStructure(avoid, structureOf(view));
        tables.set(view, routed);
        if (live) setHeld({ view, table: routed });
      })
      .catch((error: unknown) => {
        if (warned) return;
        warned = true;
        console.warn('Architecture Atlas keeps its authored wires: wire routing is unavailable.', error);
      });
    return () => { live = false; };
  }, [view]);
  if (view === null) return null;
  return held.view === view ? held.table : tables.get(view) ?? null;
}
