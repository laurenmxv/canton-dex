import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAsync } from '../app/useAsync';
import { isReconciling, isSettling } from '../features/onboarding/progress';
import type { Onboarding, OnboardingStatus } from '../lib/api/types';

afterEach(() => vi.useRealTimers());

function at(status: OnboardingStatus): Onboarding {
  return { status } as Onboarding;
}

describe('what a screen keeps watching', () => {
  it.each([
    'AWAITING_REVIEW_AND_PARTY',
    'AWAITING_REVIEW',
    'AWAITING_PARTY',
    'PARTY_SUBMITTING',
    'LEDGER_PENDING',
    'LEDGER_SUBMITTING',
  ] as const)('keeps watching %s, which moves without the reader', (status) => {
    expect(isSettling(at(status))).toBe(true);
  });

  it.each(['PARTY_UNRESOLVED', 'LEDGER_UNRESOLVED'] as const)(
    'keeps watching %s, because the venue reconciles it',
    (status) => {
      expect(isSettling(at(status))).toBe(true);
      expect(isReconciling(at(status))).toBe(true);
    },
  );

  it.each(['COMPLETED', 'REJECTED'] as const)('stops at %s, which nothing will move', (status) => {
    expect(isSettling(at(status))).toBe(false);
    expect(isReconciling(at(status))).toBe(false);
  });
});

describe('an operator queue left open', () => {
  it('is still asking after ten minutes', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => []);
    renderHook(() => useAsync(run, [], { pollWhile: () => true }));
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(201 * 3_000);
    });
    const before = run.mock.calls.length;
    expect(before).toBeGreaterThan(200);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(run.mock.calls.length).toBeGreaterThan(before);
  });

  it('asks once per interval, never twice at a time', async () => {
    vi.useFakeTimers();
    let inFlight = 0;
    let peak = 0;
    const run = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      inFlight -= 1;
      return [];
    });
    renderHook(() => useAsync(run, [], { pollWhile: () => true }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(peak).toBe(1);
  });

  it('stops for good once the screen is gone', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => []);
    const view = renderHook(() => useAsync(run, [], { pollWhile: () => true }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });

    view.unmount();
    const after = run.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(run.mock.calls.length).toBe(after);
  });
});

describe('a venue that keeps refusing', () => {
  it('is asked less often, and at once again after it answers', async () => {
    vi.useFakeTimers();
    let answer: 'ok' | 'fail' = 'fail';
    const run = vi.fn(async () => {
      if (answer === 'fail') throw new Error('The venue is unreachable');
      return ['value'];
    });
    renderHook(() => useAsync(run, [], { pollWhile: () => true }));
    await act(async () => {
      await Promise.resolve();
    });

    // One failed read, so nothing is scheduled: the first answer never landed.
    expect(run.mock.calls.length).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(run.mock.calls.length).toBe(1);
  });
});

describe('a poll that fails after data has landed', () => {
  it('keeps watching, and the next success clears the error', async () => {
    vi.useFakeTimers();
    let answer: 'ok' | 'fail' = 'ok';
    const run = vi.fn(async () => {
      if (answer === 'fail') throw new Error('The venue is unreachable');
      return ['value'];
    });
    const { result } = renderHook(() => useAsync(run, [], { pollWhile: () => true }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.data).toEqual(['value']);

    answer = 'fail';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    // The record stays on screen beside the error.
    expect(result.current.error?.message).toBe('The venue is unreachable');
    expect(result.current.data).toEqual(['value']);

    answer = 'ok';
    // The first refusal doubles the wait, so the next read is six seconds out.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(result.current.error).toBeUndefined();
  });
});

describe('a tab that goes away mid-read', () => {
  function hide(visibility: { state: DocumentVisibilityState }) {
    visibility.state = 'hidden';
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
  }

  function show(visibility: { state: DocumentVisibilityState }) {
    visibility.state = 'visible';
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
  }

  it('drops the read, resumes with exactly one, and ignores the late answer', async () => {
    const visibility = { state: 'visible' as DocumentVisibilityState };
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility.state);

    const settle: ((value: string[]) => void)[] = [];
    const signals: AbortSignal[] = [];
    const run = vi.fn(
      (signal: AbortSignal) =>
        new Promise<string[]>((resolve) => {
          signals.push(signal);
          settle.push(resolve);
        }),
    );
    const { result } = renderHook(() => useAsync(run, [], { pollWhile: () => true }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(run).toHaveBeenCalledTimes(1);

    hide(visibility);
    expect(signals[0]?.aborted).toBe(true);

    show(visibility);
    await act(async () => {
      await Promise.resolve();
    });
    // Exactly one new read, never two racing each other.
    expect(run).toHaveBeenCalledTimes(2);

    // The read the reader walked away from answers late, and is ignored.
    await act(async () => {
      settle[0]!(['stale']);
      await Promise.resolve();
    });
    expect(result.current.data).toBeUndefined();

    await act(async () => {
      settle[1]!(['fresh']);
      await Promise.resolve();
    });
    expect(result.current.data).toEqual(['fresh']);

    vi.restoreAllMocks();
  });

  it('leaves no spinner behind when it drops the read', async () => {
    const visibility = { state: 'visible' as DocumentVisibilityState };
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility.state);
    const { result } = renderHook(() =>
      useAsync(() => new Promise<string[]>(() => {}), [], { pollWhile: () => true }),
    );
    expect(result.current.loading).toBe(true);

    hide(visibility);

    expect(result.current.loading).toBe(false);
    vi.restoreAllMocks();
  });

  it('stops scheduling once the answer says there is nothing more to come', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => ['done']);
    renderHook(() => useAsync(run, [], { pollWhile: (data) => data[0] !== 'done' }));
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
