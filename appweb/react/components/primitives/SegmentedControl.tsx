import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import { classNames } from './classNames.ts';

export interface SegmentedControlOption<T extends string | number> {
  readonly value: T;
  readonly label: ReactNode;
  readonly ariaLabel?: string;
  readonly disabled?: boolean;
}

export interface SegmentedControlProps<T extends string | number>
  extends Omit<ComponentPropsWithoutRef<'div'>, 'aria-label' | 'onChange' | 'role'> {
  ariaLabel: string;
  /** Report a click on the active option when repeating it has domain meaning. */
  allowReselect?: boolean;
  disabled?: boolean;
  onChange: (value: T) => void;
  options: readonly SegmentedControlOption<T>[];
  value: T;
}

export function SegmentedControl<T extends string | number>({
  ariaLabel,
  allowReselect = false,
  className,
  disabled = false,
  onChange,
  options,
  value,
  ...props
}: SegmentedControlProps<T>) {
  return (
    <div {...props} className={classNames('segctl', className)} role="group" aria-label={ariaLabel}>
      {options.map((option) => {
        const selected = option.value === value;

        return (
          <button
            key={String(option.value)}
            type="button"
            className={selected ? 'on' : undefined}
            data-v={String(option.value)}
            aria-label={option.ariaLabel}
            aria-pressed={selected}
            disabled={disabled || option.disabled}
            onClick={() => {
              if (!selected || allowReselect) onChange(option.value);
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
