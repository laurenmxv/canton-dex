import type { ReactNode } from 'react';

export type StepState = 'done' | 'current' | 'todo';

export interface StepItem {
  title: ReactNode;
  state: StepState;
  body?: ReactNode;
}

/** Makes the explicit stage of a flow visible, one row per step. */
export function Steps({ steps }: { steps: StepItem[] }) {
  return (
    <ol className="steps">
      {steps.map((step, index) => (
        <li key={index} className={`step step-${step.state}`}>
          <span className="step-marker" aria-hidden="true">
            {step.state === 'done' ? '✓' : index + 1}
          </span>
          <div>
            <div className="step-title">
              {step.title}
              <span className="sr-only">
                {step.state === 'done' ? ' (complete)' : step.state === 'current' ? ' (current)' : ''}
              </span>
            </div>
            {step.body ? <div className="step-body">{step.body}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
