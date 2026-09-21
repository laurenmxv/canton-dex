import { act, cleanup, renderHook, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyStoredTheme, useTheme } from '../app/useTheme';
import { renderApp } from './harness';
import { setSystemDark } from './viewport';

const KEY = 'canton-dex.theme';

beforeEach(() => document.documentElement.classList.remove('dark'));

describe('the theme a reader chose', () => {
  it('outlives the page, which is what a sign-in reload is', () => {
    const first = renderHook(() => useTheme());
    expect(first.result.current.dark).toBe(false);

    act(() => first.result.current.toggle());
    expect(first.result.current.dark).toBe(true);
    first.unmount();

    // A redirect through the identity provider reloads everything.
    const second = renderHook(() => useTheme());
    expect(second.result.current.dark).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('is theirs both ways round', () => {
    window.localStorage.setItem(KEY, 'dark');
    const view = renderHook(() => useTheme());
    expect(view.result.current.dark).toBe(true);

    act(() => view.result.current.toggle());
    view.unmount();

    expect(window.localStorage.getItem(KEY)).toBe('light');
    expect(renderHook(() => useTheme()).result.current.dark).toBe(false);
  });

  it('wins over the system preference once it exists', () => {
    setSystemDark(true);
    window.localStorage.setItem(KEY, 'light');

    expect(renderHook(() => useTheme()).result.current.dark).toBe(false);
  });
});

describe('a reader who has not chosen', () => {
  it('gets what their system asks for', () => {
    setSystemDark(true);
    expect(renderHook(() => useTheme()).result.current.dark).toBe(true);

    setSystemDark(false);
    expect(renderHook(() => useTheme()).result.current.dark).toBe(false);
  });

  it('has nothing stored on their behalf', () => {
    renderHook(() => useTheme());
    expect(window.localStorage.length).toBe(0);
  });
});

describe('before React renders', () => {
  it('puts the stored theme on the document, so no default flashes first', () => {
    window.localStorage.setItem(KEY, 'dark');

    applyStoredTheme();

    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('follows the system when nothing is stored', () => {
    setSystemDark(true);
    applyStoredTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});

describe('a browser that refuses to remember anything', () => {
  it('still honours the toggle for as long as the page lives', () => {
    // The instance delegates to the prototype, so that is where the refusal
    // has to sit for the hook to meet it.
    const refuse = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage is disabled');
    });
    const view = renderHook(() => useTheme());

    act(() => view.result.current.toggle());

    expect(refuse).toHaveBeenCalled();
    expect(view.result.current.dark).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('stores nothing that says who the reader is', () => {
    const view = renderHook(() => useTheme());
    act(() => view.result.current.toggle());

    const keys = Array.from({ length: window.localStorage.length }, (_, index) =>
      window.localStorage.key(index),
    );
    expect(keys).toEqual([KEY]);
    expect(window.localStorage.getItem(KEY)).toBe('dark');
  });
});

describe('the whole app', () => {
  it('opens in the theme the reader last chose', async () => {
    const { user } = renderApp();

    await user.click(await screen.findByRole('button', { name: 'Switch to dark theme' }));
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    // Everything is torn down and built again, as a sign-in redirect does.
    cleanup();
    applyStoredTheme();
    renderApp();

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(await screen.findByRole('button', { name: 'Switch to light theme' })).toBeInTheDocument();
  });
});
