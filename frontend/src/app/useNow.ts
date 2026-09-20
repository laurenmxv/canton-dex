import { useEffect, useState } from 'react';

/**
 * Re-renders once a second while `active`, so a countdown never freezes.
 *
 * It keeps no timer when there is nothing counting down, which is what stops a
 * settled screen from waking the tab every second.
 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
