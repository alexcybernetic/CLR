import type { HTMLAttributes } from 'react';

export interface BrandProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  version: string;
  variant?: 'header' | 'start';
  titleId?: string;
}

/** The single markup contract for CLR's reserved logo lockup. */
export function Brand({
  version,
  variant = 'header',
  titleId,
  className = '',
  ...props
}: BrandProps) {
  const classes = ['brand-logo', variant === 'start' ? 'start-brand-logo' : '', className]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={classes} {...props}>
      <b className="brand-acronym" id={titleId}>
        CLR<span className="brand-version">{version}</span>
      </b>
      <em className="brand-full">computational life reactor</em>
    </span>
  );
}
