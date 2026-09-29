import { describe, expect, it } from 'vitest';
import { initialState, layerIds, model, readRoute, routeHash, sourceUrl } from './content';

describe('architecture routes', () => {
  it('names only the structural view in a link', () => {
    expect(routeHash({ view: 'backend' })).toBe('#/dev/docs/architecture/backend');
    expect(readRoute(routeHash({ view: 'contracts' }))).toEqual({ view: 'contracts' });
    for (const view of layerIds) expect(readRoute(routeHash({ view }))).toEqual({ view });
  });

  it('opens the structural view of an old flow link and keeps none of its flow settings', () => {
    const old = '#/dev/docs/architecture/backend?flow=pool-swap&branch=normal&phase=settle&settlementTrigger=manual&depositMode=initialize&focus=backend.swaps';
    expect(readRoute(old)).toEqual({ view: 'backend' });
  });

  it('opens System for a removed Canton view and for hashes outside the Atlas', () => {
    expect(readRoute('#/dev/docs/architecture/canton?flow=pool-swap')).toEqual(initialState);
    expect(readRoute('#main')).toEqual(initialState);
    expect(readRoute('#/backend')).toEqual(initialState);
    expect(model.layers.canton, 'Canton stays a model layer').toBeDefined();
  });

  it('links a choice to its exact Daml source line', () => {
    expect(sourceUrl(model.choices['Pool_AddLiquidity']!.source)).toBe(
      'https://github.com/OpenZeppelin/canton-dex/blob/c36dd63249cd36e6665e6fd41bb2f43800a37c4f/contracts/daml/Pool.daml#L85',
    );
  });
});

describe('architecture model', () => {
  it('describes structure only; flows live in the Daml flow sources', () => {
    expect(Object.keys(model).sort()).toEqual(['C', 'N', 'baseline', 'choices', 'documentationSources', 'layers', 'nodes', 'overview', 'sourceRoot']);
  });

  it('documents the database client from the backend database module and keeps PostgreSQL external', () => {
    const client = model.nodes[model.N.dbClient!]!;
    expect(client.layer).toBe('backend');
    expect(client.title).toBe('Database client');
    expect(client.documentation?.path).toBe('backend/src/platform/database.ts');
    expect(model.layers.backend!.nodes).toContain(model.N.dbClient);
    expect(model.nodes[model.N.database!]!.external).toBe(true);
  });
});
