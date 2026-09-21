import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';
import { installMatchMedia, resetViewport } from './viewport';

/**
 * Everything below is about a browser. A test that drives node tooling runs
 * without one, and has nothing here to set up or clean.
 */
const inBrowser = typeof window !== 'undefined';

if (inBrowser) installMatchMedia();

/**
 * Three answers a browser gives and jsdom does not.
 *
 * The kit's listbox trigger probes `hasPointerCapture` on pointer-down, so
 * without it no listbox opens at all. The open listbox calls `scrollIntoView`
 * on the active option. The popper that carries it measures its anchor through
 * a `ResizeObserver` before it places itself, and waits forever without one.
 */
if (inBrowser) {
  const element = window.Element.prototype as unknown as Record<string, unknown>;
  element['hasPointerCapture'] ??= () => false;
  element['scrollIntoView'] ??= () => {};

  window.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

beforeEach(() => {
  if (!inBrowser) return;
  window.localStorage?.clear();
  resetViewport();
});

afterEach(() => {
  if (inBrowser) cleanup();
});
