import { useId } from 'react';
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';

interface FieldShell {
  label: string;
  hint?: ReactNode;
  error?: string;
  /**
   * Keeps the label for assistive technology and takes it off the screen, for
   * a control whose own panel already names it. The control keeps its name.
   */
  hideLabel?: boolean;
  /** Extra classes on the control itself, for a field a panel restyles. */
  controlClassName?: string;
}

/** The hint stays visible beside an error, because that is when it helps most. */
function describedBy(id: string, hint: ReactNode, error: string | undefined): string | undefined {
  const ids = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean);
  return ids.length > 0 ? ids.join(' ') : undefined;
}

function controlProps(
  id: string,
  hint: ReactNode,
  error: string | undefined,
  extra: string | undefined,
) {
  return {
    id,
    className: ['control', error ? 'control-invalid' : '', extra ?? ''].filter(Boolean).join(' '),
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy(id, hint, error),
  };
}

function Shell({
  label,
  hint,
  error,
  hideLabel,
  controlId,
  children,
}: FieldShell & { controlId: string; children: ReactNode }) {
  return (
    <div className="field">
      <label className={hideLabel ? 'sr-only' : 'field-label'} htmlFor={controlId}>
        {label}
      </label>
      {children}
      {hint ? (
        <p className="field-hint" id={`${controlId}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field-error" id={`${controlId}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function TextField({
  label,
  hint,
  error,
  hideLabel,
  controlClassName,
  ...rest
}: FieldShell & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <Shell label={label} hint={hint} error={error} hideLabel={hideLabel} controlId={id}>
      <input {...controlProps(id, hint, error, controlClassName)} {...rest} />
    </Shell>
  );
}

export function SelectField({
  label,
  hint,
  error,
  hideLabel,
  controlClassName,
  children,
  ...rest
}: FieldShell & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return (
    <Shell label={label} hint={hint} error={error} hideLabel={hideLabel} controlId={id}>
      <select {...controlProps(id, hint, error, controlClassName)} {...rest}>
        {children}
      </select>
    </Shell>
  );
}
