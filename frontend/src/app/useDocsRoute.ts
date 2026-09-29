import { useCallback, useEffect, useState } from 'react';
import { DOCS_HOME, isDocsHash, isRouteHash } from '../features/docs/routes';

/**
 * Whether the docs are open, kept in step with the URL.
 *
 * Opening the docs pushes their hash, and leaving them pushes the bare path,
 * so back and forward move between the docs and the trading screens.
 */
export function useDocsRoute() {
  const [docs, setDocs] = useState(() => isDocsHash(window.location.hash));

  useEffect(() => {
    const sync = () => {
      const { hash } = window.location;
      if (isRouteHash(hash)) setDocs(isDocsHash(hash));
    };
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);

  // Always the index, even from a docs page.
  const open = useCallback(() => {
    if (window.location.hash !== DOCS_HOME) window.location.hash = DOCS_HOME;
    setDocs(true);
  }, []);

  const leave = useCallback(() => {
    const { hash, pathname, search } = window.location;
    if (isDocsHash(hash)) window.history.pushState(null, '', pathname + search);
    setDocs(false);
  }, []);

  return { docs, open, leave };
}
