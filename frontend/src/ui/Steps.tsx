import type { ReactNode } from 'react';

export type StepState = 'done' | 'current' | 'todo';

export interface StepItem {
  title: ReactNode;
  state: StepState;
  body?: ReactNode;
}

/** What a reader who cannot see the marker hears after the title. */
const STATE_SUFFIX: Record<StepState, string> = {
  done: ' (complete)',
  current: ' (current)',
  todo: '',
};

const MARKER: Record<StepState, string> = {
  done: 'border-success bg-success text-background',
  current: 'border-primary bg-primary text-primary-foreground',
  todo: 'bg-card text-muted-foreground',
};

/**
 * Makes the explicit stage of a flow visible, one row per step.
 *
 * A rail joins the markers, and the part of it already behind the reader is
 * drawn as travelled. OpenZeppelin's wizard stepper navigates between steps;
 * this one is a record of what the ledger has done, so it stays read-only and
 * carries a body under each step.
 */
export function Steps({ steps }: { steps: StepItem[] }) {
  return (
    <ol className="flex flex-col">
      {steps.map((step, index) => {
        const last = index === steps.length - 1;
        return (
          <li
            key={index}
            className={`relative grid grid-cols-[1.5rem_minmax(0,1fr)] gap-3 ${
              last ? '' : 'pb-5'
            }`}
          >
            {last ? null : (
              <span
                aria-hidden="true"
                className={`absolute top-7 bottom-1 left-[0.6875rem] w-px ${
                  step.state === 'done'
                    ? 'bg-[color-mix(in_oklab,var(--success)_40%,var(--border))]'
                    : 'bg-border'
                }`}
              />
            )}
            <span
              aria-hidden="true"
              className={`z-1 grid size-6 flex-none place-items-center rounded-full border text-[0.6875rem] font-semibold ${
                MARKER[step.state]
              }`}
            >
              {step.state === 'done' ? '✓' : index + 1}
            </span>
            <div>
              <div
                data-slot="step-title"
                className={`text-sm leading-6 font-medium ${
                  step.state === 'todo' ? 'text-muted-foreground' : ''
                }`}
              >
                {step.title}
                <span className="sr-only">
                  {STATE_SUFFIX[step.state]}
                </span>
              </div>
              {step.body ? <div className="mt-2">{step.body}</div> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
