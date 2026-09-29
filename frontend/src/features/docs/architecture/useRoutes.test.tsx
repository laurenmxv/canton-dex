import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RouteTable } from './routing';
import { useRoutes } from './useRoutes';

vi.mock('libavoid-js', () => ({ AvoidLib: { load: vi.fn(async () => {}), getInstance: () => ({}) } }));
// Each table names the view it was routed for.
vi.mock('./routing', () => ({
  structureOf: (view: string) => view,
  routeStructure: (_avoid: unknown, view: string) => ({ routes: new Map(), bounds: { x: 0, y: 0, width: 0, height: 0 }, view }),
}));

const viewOf = (table: RouteTable | null) => (table as (RouteTable & { view: string }) | null)?.view ?? null;

describe('routed wires per view', () => {
  it('never answer a view with the wires of the view before it', async () => {
    const seen: [string | null, string | null][] = [];
    const { result, rerender } = renderHook(({ view }: { view: string | null }) => {
      const table = useRoutes(view);
      seen.push([view, viewOf(table)]);
      return table;
    }, { initialProps: { view: 'client' as string | null } });
    await waitFor(() => expect(viewOf(result.current)).toBe('client'));

    rerender({ view: 'frontend' });
    await waitFor(() => expect(viewOf(result.current)).toBe('frontend'));
    rerender({ view: null });
    expect(result.current).toBeNull();
    rerender({ view: 'client' });
    expect(viewOf(result.current), 'a routed view answers from its cache at once').toBe('client');

    for (const [view, table] of seen) expect(table === null || table === view, `${view} showed ${table}`).toBe(true);
  });
});
