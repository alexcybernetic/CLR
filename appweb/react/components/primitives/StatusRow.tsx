import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import { classNames } from './classNames.ts';

export interface StatusRowProps extends ComponentPropsWithoutRef<'div'> {
  caption: ReactNode;
}

export function StatusRow({ caption, children, className, ...props }: StatusRowProps) {
  return (
    <div className={classNames('status-row', className)} {...props}>
      <span className="status-cap">{caption}</span>
      {children}
    </div>
  );
}

export type StatusValueProps = ComponentPropsWithoutRef<'span'>;

export function StatusValue({ className, ...props }: StatusValueProps) {
  return <span className={classNames('status-val', className)} {...props} />;
}
