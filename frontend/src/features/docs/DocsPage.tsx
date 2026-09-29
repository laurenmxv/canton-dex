import { lazy, Suspense, useEffect, useState } from 'react';
import { Loading } from '../../ui/States';
import { DocsIndex } from './DocsIndex';
import { docsPageOf, isDocsHash } from './routes';

/** Loaded on first open, so the index never loads the diagram library. */
const AtlasPage = lazy(() =>
  import('./architecture/AtlasPage').then((module) => ({ default: module.AtlasPage })),
);

/** Loaded on first open, with the native flow renderer. */
const FlowsPage = lazy(() =>
  import('./flows/FlowsPage').then((module) => ({ default: module.FlowsPage })),
);

/** The page the URL names, kept in step with hash changes inside the docs. */
function useDocsPage() {
  const [page, setPage] = useState(() => docsPageOf(window.location.hash));

  useEffect(() => {
    const sync = () => {
      const { hash } = window.location;
      if (isDocsHash(hash)) setPage(docsPageOf(hash));
    };
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);

  return page;
}

/** The developer docs: an index, and one page per entry on it. */
export function DocsPage() {
  const page = useDocsPage();

  if (page === 'index') return <DocsIndex />;
  if (page === 'flows') {
    return (
      <Suspense fallback={<Loading label="Loading the Daml flows" />}>
        <FlowsPage />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={<Loading label="Loading the Architecture Atlas" />}>
      <AtlasPage />
    </Suspense>
  );
}
