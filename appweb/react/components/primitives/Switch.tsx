import type { ComponentPropsWithoutRef, MouseEvent, ReactNode } from 'react';

import { classNames } from './classNames.ts';

export interface SwitchProps
  extends Omit<ComponentPropsWithoutRef<'button'>, 'aria-checked' | 'onChange' | 'role'> {
  checked: boolean;
  label?: ReactNode;
  onCheckedChange: (checked: boolean) => void;
  scale?: 'sm' | 'lg';
}

export function Switch({
  checked,
  className,
  label,
  onCheckedChange,
  onClick,
  scale,
  type = 'button',
  ...props
}: SwitchProps) {
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (!event.defaultPrevented) onCheckedChange(!checked);
  };

  return (
    <button
      type={type}
      className={classNames('sw', scale && `sw-${scale}`, className)}
      role="switch"
      aria-checked={checked}
      onClick={handleClick}
      {...props}
    >
      {label === undefined ? null : <span className="sw-cap">{label}</span>}
      <span className="sw-track" aria-hidden="true">
        <span className="sw-nub" />
      </span>
    </button>
  );
}
