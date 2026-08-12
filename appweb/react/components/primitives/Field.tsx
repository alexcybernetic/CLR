import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import { classNames } from './classNames.ts';

export interface FieldProps extends ComponentPropsWithoutRef<'div'> {
  caption?: ReactNode;
  labelFor?: string;
  push?: boolean;
}

export function Field({ caption, children, className, labelFor, push = false, ...props }: FieldProps) {
  const captionElement = labelFor ? (
    <label className="field-cap" htmlFor={labelFor}>
      {caption}
    </label>
  ) : (
    <span className="field-cap">{caption}</span>
  );

  return (
    <div className={classNames('field', push && 'field-push', className)} {...props}>
      {captionElement}
      <div className="field-row">{children}</div>
    </div>
  );
}
