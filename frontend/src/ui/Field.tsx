import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@openzeppelin/ui-components';
import { cn } from '@openzeppelin/ui-utils';
import { forwardRef, useId } from 'react';
import type { FocusEventHandler, InputHTMLAttributes, ReactNode } from 'react';

/**
 * Standalone controls: a search box, a filter, a single value a screen reads
 * straight into its own state.
 *
 * The kit's `TextField` and `SelectField` are React Hook Form fields and need
 * a `control`. The venue's real forms use those. A filter above a table is not
 * a form, and wrapping one in a form to satisfy a prop would cost the reader a
 * submit path that does not exist. These compose the same kit primitives
 * around plain controlled state.
 */
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

/** Points the control at whichever of the hint and the error is on screen. */
function describedBy(id: string, hint: ReactNode, error: string | undefined): string | undefined {
  const ids = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean);
  return ids.length > 0 ? ids.join(' ') : undefined;
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
    <div className="flex flex-col gap-1.5">
      <Label className={hideLabel ? 'sr-only' : 'text-xs font-medium'} htmlFor={controlId}>
        {label}
      </Label>
      {children}
      {hint ? (
        <p className="text-muted-foreground text-[0.75rem]" id={`${controlId}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="text-destructive text-[0.75rem]" id={`${controlId}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function TextControl({
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
      <Input
        id={id}
        className={cn(error && 'border-destructive', controlClassName)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        {...rest}
      />
    </Shell>
  );
}

export interface ControlOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/**
 * One value out of a short list, on the kit's listbox.
 *
 * The options come as data rather than as children, because the listbox builds
 * its own rows and a bare `<option>` would never reach it.
 *
 * The trigger takes the forwarded ref and `onBlur`, so a React Hook Form
 * `Controller` can hand over its whole contract: the field is marked touched
 * when the reader leaves it, and the form can put the focus on it when it is
 * the first one to fail.
 */
export const SelectControl = forwardRef<
  HTMLButtonElement,
  FieldShell & {
    options: readonly ControlOption[];
    value: string;
    onValueChange: (value: string) => void;
    onBlur?: FocusEventHandler<HTMLButtonElement>;
    disabled?: boolean;
    placeholder?: string;
  }
>(function SelectControl(
  {
    label,
    hint,
    error,
    hideLabel,
    controlClassName,
    options,
    value,
    onValueChange,
    onBlur,
    disabled,
    placeholder,
  },
  ref,
) {
  const id = useId();
  return (
    <Shell label={label} hint={hint} error={error} hideLabel={hideLabel} controlId={id}>
      <Select value={value} onValueChange={onValueChange} disabled={disabled}>
        <SelectTrigger
          id={id}
          ref={ref}
          onBlur={onBlur}
          className={cn(error && 'border-destructive', controlClassName)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, hint, error)}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Shell>
  );
});
