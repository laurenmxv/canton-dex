import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';
import { installMatchMedia, resetViewport } from './viewport';

/**
 * Node 26 ships a `localStorage` global that stays disabled without
 * `--localstorage-file`, and it shadows the one jsdom provides. Browsers have
 * the real thing, so this only restores what the test environment removed.
 */
if (typeof window !== 'undefined' && !window.localStorage) {
  const entries = new Map<string, string>();
  const memoryStorage: Storage = {
    get length() {
      return entries.size;
    },
    key: (index) => Array.from(entries.keys())[index] ?? null,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, String(value)),
    removeItem: (key) => void entries.delete(key),
    clear: () => entries.clear(),
  };
  Object.defineProperty(window, 'localStorage', { value: memoryStorage, configurable: true });
}

/**
 * Everything below is about a browser. A test that drives node tooling runs
 * without one, and has nothing here to set up or clean.
 */
const inBrowser = typeof window !== 'undefined';

if (inBrowser) installMatchMedia();

beforeEach(() => {
  if (!inBrowser) return;
  window.localStorage?.clear();
  resetViewport();
});

afterEach(() => {
  if (inBrowser) cleanup();
});
