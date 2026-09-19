/**
 * jsdom ships no `matchMedia`, so the responsive sidebar would throw. This is
 * a small, controllable stand-in: tests set a width and the listeners fire,
 * the same way a real resize behaves.
 */
const DESKTOP_WIDTH = 1280;

type Listener = () => void;

let width = DESKTOP_WIDTH;
let darkSystem = false;
const listeners = new Map<Listener, string>();

/** Understands the two query forms the app uses, and nothing else. */
function matches(query: string): boolean {
  if (query.includes('prefers-color-scheme: dark')) return darkSystem;
  const max = /\(max-width:\s*(\d+)px\)/.exec(query);
  return max ? width <= Number(max[1]) : false;
}

/** Stands in for a reader whose system asks for a dark theme. */
export function setSystemDark(value: boolean): void {
  darkSystem = value;
}

export function installMatchMedia(): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const list = {
        media: query,
        get matches() {
          return matches(query);
        },
        addEventListener: (_: string, listener: Listener) => void listeners.set(listener, query),
        removeEventListener: (_: string, listener: Listener) => void listeners.delete(listener),
        dispatchEvent: () => true,
        onchange: null,
      };
      return list as unknown as MediaQueryList;
    },
  });
}

/** Fires only the listeners whose own query changed, as a browser does. */
export function setViewportWidth(next: number): void {
  const before = new Map<Listener, boolean>();
  listeners.forEach((query, listener) => before.set(listener, matches(query)));
  width = next;
  listeners.forEach((query, listener) => {
    if (before.get(listener) !== matches(query)) listener();
  });
}

/**
 * Deliberately leaves the listeners in place. React unmounts every tree after
 * each test, so a listener still here means a hook failed to remove its own.
 */
export function resetViewport(): void {
  width = DESKTOP_WIDTH;
  darkSystem = false;
}

/** Narrow enough that the sidebar becomes a drawer. */
export const PHONE_WIDTH = 480;
