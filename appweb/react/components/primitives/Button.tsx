import type { ComponentPropsWithoutRef } from 'react';

import { classNames } from './classNames.ts';

export type ButtonProps = ComponentPropsWithoutRef<'button'>;

export function Button({ className, type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={classNames('btn', className)} {...props} />;
}

export interface HelpButtonProps extends Omit<ButtonProps, 'aria-pressed'> {
  pressed: boolean;
  topic: string;
  variant?: 'global' | 'module';
}

export function HelpButton({
  'aria-label': ariaLabel,
  children,
  className,
  pressed,
  topic,
  variant = 'module',
  ...props
}: HelpButtonProps) {
  const compact = variant === 'module';

  return (
    <Button
      className={classNames(compact ? 'btn-hlp' : 'btn-help', className)}
      data-help={topic}
      aria-label={ariaLabel ?? (compact ? `help: ${topic}` : undefined)}
      aria-pressed={pressed}
      {...props}
    >
      {children ?? (compact ? '?' : '? help')}
    </Button>
  );
}
