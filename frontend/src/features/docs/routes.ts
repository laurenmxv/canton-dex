/**
 * Hash routes of the developer docs. Trading screens keep their local view
 * state; only docs pages live in the URL, so a link or a reload opens them.
 */
export const DOCS_HASH_PREFIX = '#/dev/docs';

/** The docs index, which lists every docs page. */
export const DOCS_HOME = DOCS_HASH_PREFIX;

const ARCHITECTURE_HASH = `${DOCS_HASH_PREFIX}/architecture`;

export const ARCHITECTURE_HASH_PREFIX = `${ARCHITECTURE_HASH}/`;

/** The Architecture Atlas on its first layer. */
export const ARCHITECTURE_HOME = `${ARCHITECTURE_HASH_PREFIX}system`;

const FLOWS_HASH = `${DOCS_HASH_PREFIX}/flows`;

export const FLOWS_HASH_PREFIX = `${FLOWS_HASH}/`;

/** The Daml flows page; it opens its first flow. */
export const FLOWS_HOME = FLOWS_HASH;

export const flowHash = (id: string) => `${FLOWS_HASH_PREFIX}${id}`;

export type DocsPageId = 'index' | 'architecture' | 'flows';

export function isDocsHash(hash: string): boolean {
  return hash === DOCS_HASH_PREFIX || hash.startsWith(`${DOCS_HASH_PREFIX}/`);
}

export function isArchitectureHash(hash: string): boolean {
  return hash === ARCHITECTURE_HASH || hash.startsWith(ARCHITECTURE_HASH_PREFIX);
}

export function isFlowsHash(hash: string): boolean {
  return hash === FLOWS_HASH || hash.startsWith(FLOWS_HASH_PREFIX);
}

/** The flow a flows hash names, or '' for the page's first flow. */
export function flowIdOf(hash: string): string {
  return hash.startsWith(FLOWS_HASH_PREFIX) ? hash.slice(FLOWS_HASH_PREFIX.length).split('?')[0]! : '';
}

/** The docs page a docs hash names. An unknown page falls back to the index. */
export function docsPageOf(hash: string): DocsPageId {
  if (isArchitectureHash(hash)) return 'architecture';
  return isFlowsHash(hash) ? 'flows' : 'index';
}

/**
 * True for a hash that names an app route. An in-page anchor such as the
 * `#main` skip link is not one, so it never opens or closes a page.
 */
export function isRouteHash(hash: string): boolean {
  return hash === '' || hash === '#' || hash.startsWith('#/');
}
