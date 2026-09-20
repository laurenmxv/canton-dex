import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncResult<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
}

/**
 * How often a screen re-reads work the venue is still settling.
 *
 * There is no ceiling on the number of reads: a review can take as long as the
 * operator takes, and a queue has to keep discovering requests. What bounds the
 * cost is that a hidden tab asks nothing, an unmounted screen stops, and a
 * venue that keeps refusing is asked progressively less often.
 */
const POLL_INTERVAL_MS = 3_000;
const MAX_BACKOFF_MS = 60_000;

interface AsyncOptions<T> {
  /** Re-runs on an interval while true, for work that settles over time. */
  pollWhile?: (data: T) => boolean;
  enabled?: boolean;
}

/** True while the tab is on screen. A hidden tab polls nothing. */
function isVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

/**
 * Loads data and tracks the loading, empty and error states every screen shows.
 *
 * One request is in flight at a time, and each carries its own abort signal, so
 * a read the screen has stopped waiting for can be dropped without touching the
 * next one. A dependency change, which is what an identity change is, drops the
 * read and everything already loaded, so nothing of the previous caller's can
 * reach the screen.
 */
export function useAsync<T>(
  run: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  options: AsyncOptions<T> = {},
): AsyncResult<T> {
  const { pollWhile, enabled = true } = options;
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(enabled);
  const [nonce, setNonce] = useState(0);
  const runRef = useRef(run);
  runRef.current = run;
  /**
   * What is on screen right now, read from the render rather than from a flag
   * the effect owns. A reload re-runs the effect; the data it already fetched
   * is still there, so a manual retry that also fails must not stop the
   * automatic polling that was watching on the reader's behalf.
   */
  const shown = useRef(data);
  shown.current = data;
  const failures = useRef(0);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  // A dependency change is a different subject: what was loaded for the last
  // one is dropped rather than left on screen under a new heading.
  useEffect(() => {
    failures.current = 0;
    setData(undefined);
    setError(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    /** True while the last answer said there is more to come. */
    let polling = pollWhile !== undefined;
    /** The read the screen is still waiting for, if any. */
    let current: AbortController | undefined;

    const schedule = () => {
      if (!active) return;
      // Steady while the venue answers; backing off while it refuses.
      const delay = Math.min(POLL_INTERVAL_MS * 2 ** failures.current, MAX_BACKOFF_MS);
      timer = setTimeout(() => {
        timer = undefined;
        void load(false);
      }, delay);
    };

    const load = async (showSpinner: boolean) => {
      if (inFlight) return;
      // A hidden tab asks nothing. It keeps a timer only where there is work to
      // come back to, so a one-shot read leaves nothing behind.
      if (!isVisible()) {
        if (showSpinner) setLoading(false);
        if (polling) schedule();
        return;
      }
      const controller = new AbortController();
      current = controller;
      inFlight = true;
      if (showSpinner) setLoading(true);
      try {
        const result = await runRef.current(controller.signal);
        // An answer to a read the screen gave up on is not this screen's answer.
        if (!active || controller.signal.aborted) return;
        failures.current = 0;
        setData(result);
        setError(undefined);
        polling = pollWhile?.(result) ?? false;
        if (polling) schedule();
      } catch (cause) {
        if (!active || controller.signal.aborted) return;
        failures.current += 1;
        setError(cause instanceof Error ? cause : new Error(String(cause)));
        // One refused answer is not the end of work already under way: keep
        // watching, and let the next success clear the error.
        if (shown.current !== undefined) schedule();
      } finally {
        if (current === controller) {
          current = undefined;
          inFlight = false;
        }
        if (active && showSpinner) setLoading(false);
      }
    };

    /**
     * A tab leaving the screen drops the read it was waiting for rather than
     * holding a connection open for a reader who is not there, and one coming
     * back asks once. A late answer to the dropped read is discarded above.
     */
    const onVisibility = () => {
      if (!isVisible()) {
        current?.abort();
        current = undefined;
        inFlight = false;
        setLoading(false);
        if (timer) clearTimeout(timer);
        timer = undefined;
        if (polling) schedule();
        return;
      }
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (!inFlight) void load(false);
    };
    document.addEventListener?.('visibilitychange', onVisibility);

    void load(true);
    return () => {
      active = false;
      current?.abort();
      document.removeEventListener?.('visibilitychange', onVisibility);
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, enabled]);

  return { data, error, loading, reload };
}

/**
 * Asks whether the screen that started this work is still on screen.
 *
 * Work a reader starts can outlive them: a wallet dialog stays open across a
 * logout, and the identity change unmounts the screen that opened it. A step
 * that would act for that reader asks this first, so what comes back late is
 * dropped rather than submitted for whoever is signed in now.
 */
export function useLive(): () => boolean {
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  return useCallback(() => live.current, []);
}

/**
 * Runs `effect` when `token` changes, after the first value it is given.
 *
 * It is how one read reacts to another: a confirmed settlement changes what
 * the ledger says a trader holds, and the balances have to be read again to
 * find out. The first observed value is the baseline, so arriving at a screen
 * re-reads nothing.
 */
export function useChange(token: string | undefined, effect: () => void): void {
  const seen = useRef<string | undefined>(undefined);
  const run = useRef(effect);
  run.current = effect;

  useEffect(() => {
    if (token === undefined) return;
    if (seen.current === undefined || seen.current === token) {
      seen.current = token;
      return;
    }
    seen.current = token;
    run.current();
  }, [token]);
}

export interface ActionResult<A extends unknown[], T> {
  perform: (...args: A) => Promise<T | undefined>;
  pending: boolean;
  error: Error | undefined;
  clearError: () => void;
}

export function useAction<A extends unknown[], T>(
  run: (...args: A) => Promise<T>,
): ActionResult<A, T> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error>();
  const runRef = useRef(run);
  runRef.current = run;

  const perform = useCallback(async (...args: A) => {
    setPending(true);
    setError(undefined);
    try {
      return await runRef.current(...args);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
      return undefined;
    } finally {
      setPending(false);
    }
  }, []);

  return { perform, pending, error, clearError: useCallback(() => setError(undefined), []) };
}
