import { useCallback, useEffect, useState } from 'react';

/**
 * Where the reader's choice of theme is kept.
 *
 * A theme is a preference, not a credential: it is the one thing this webapp
 * stores, and it holds nothing about who the reader is. Sign-in and sign-out
 * reload the page, so without this their choice would be lost every time.
 */
const STORAGE_KEY = 'canton-dex.theme';

type Theme = 'light' | 'dark';

/** Storage is missing in a private window and disabled in some test runtimes. */
function storage(): Storage | null {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function storedTheme(): Theme | null {
  const value = storage()?.getItem(STORAGE_KEY);
  return value === 'dark' || value === 'light' ? value : null;
}

/** What the reader's system asks for, where the browser will say. */
function systemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

function prefersDark(): boolean {
  const stored = storedTheme();
  return stored === null ? systemPrefersDark() : stored === 'dark';
}

/**
 * Puts the theme on the document before React renders.
 *
 * The composition point calls this, so a reload paints the reader's own theme
 * instead of flashing the default one on its way to it.
 */
export function applyStoredTheme(): void {
  document.documentElement.classList.toggle('dark', prefersDark());
}

/**
 * The theme, remembered.
 *
 * Until the reader chooses one, their system preference decides. Once they
 * choose, that choice is theirs and outlives the page.
 */
export function useTheme() {
  const [dark, setDark] = useState(prefersDark);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);

  const toggle = useCallback(() => {
    setDark((value) => {
      const next = !value;
      try {
        storage()?.setItem(STORAGE_KEY, next ? 'dark' : 'light');
      } catch {
        // A browser that refuses to store it still honours it for this page.
      }
      return next;
    });
  }, []);

  return { dark, toggle };
}
