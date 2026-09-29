/**
 * The Daml flow diagrams. `docs/flows/*.puml` is their only source; the page renders them
 * in the browser, so no exported image can drift from its PlantUML.
 */
const files = import.meta.glob<string>('../../../../../docs/flows/*.puml', { query: '?raw', import: 'default', eager: true });

/** Reading order: access first, then the pool lifecycle. Any other flow follows by name. */
const ORDER = ['onboarding', 'pool-creation', 'pool-swap', 'pool-provide-liquidity', 'pool-withdraw-liquidity'];

export interface DamlFlow {
  id: string;
  title: string;
  /** Repository path of the source. */
  path: string;
  source: string;
}

const rank = (id: string) => (ORDER.includes(id) ? ORDER.indexOf(id) : ORDER.length);

export const flows: readonly DamlFlow[] = Object.entries(files)
  .map(([file, source]) => {
    const id = file.slice(file.lastIndexOf('/') + 1).replace(/\.puml$/, '');
    return { id, title: /^title\s+(.+)$/m.exec(source)?.[1]?.trim() ?? id, path: `docs/flows/${id}.puml`, source };
  })
  .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
