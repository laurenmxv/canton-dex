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
}

/** The hint stays visible beside an error, because that is when it helps most. */
function describedBy(id: string, hint: ReactNode, error: string | undefined): string | undefined {
  const ids = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean);
  return ids.length > 0 ? ids.join(' ') : undefined;
}

function controlProps(id: string, hint: ReactNode, error: string | undefined) {
  return {
    id,
    className: `control ${error ? 'control-invalid' : ''}`.trim(),
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy(id, hint, error),
  };
}

function Shell({
  label,
  hint,
  error,
  controlId,
  children,
}: FieldShell & { controlId: string; children: ReactNode }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={controlId}>
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
  ...rest
}: FieldShell & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <Shell label={label} hint={hint} error={error} controlId={id}>
      <input {...controlProps(id, hint, error)} {...rest} />
    </Shell>
  );
}

export function SelectField({
  label,
  hint,
  error,
  children,
  ...rest
}: FieldShell & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return (
    <Shell label={label} hint={hint} error={error} controlId={id}>
      <select {...controlProps(id, hint, error)} {...rest}>
        {children}
      </select>
    </Shell>
  );
}
