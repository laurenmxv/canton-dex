import type { Graph } from './graph-base';
import { backendDisplayGraph } from './graph-backend';
import { contractsGraph } from './graph-contracts';
import { clientGraph, frontendGraph } from './graph-layers';
import { systemGraph } from './graph-system';

/** The structural map of one view. */
export function buildGraph(view: string): Graph {
  switch (view) {
    case 'frontend': return frontendGraph();
    case 'client': return clientGraph();
    case 'backend': return backendDisplayGraph();
    case 'contracts': return contractsGraph();
    default: return systemGraph();
  }
}
