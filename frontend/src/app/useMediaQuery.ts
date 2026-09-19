import { useEffect, useState } from 'react';

/** Below this the sidebar becomes a drawer. `shell.css` matches on it too. */
export const COMPACT_MAX_PX = 900;

const COMPACT_QUERY = `(max-width: ${COMPACT_MAX_PX}px)`;

/** True while the viewport matches, kept in step with the browser. */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);

  return matches;
}

export function useIsCompact(): boolean {
  return useMediaQuery(COMPACT_QUERY);
}
