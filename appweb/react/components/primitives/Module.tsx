import type { ComponentPropsWithoutRef } from 'react';

import { classNames } from './classNames.ts';

export interface ModuleProps extends ComponentPropsWithoutRef<'section'> {
  as?: 'div' | 'section';
}

export function Module({ as: Element = 'section', className, ...props }: ModuleProps) {
  return <Element className={classNames('module', className)} {...props} />;
}

export type ModuleHeaderProps = ComponentPropsWithoutRef<'div'>;

export function ModuleHeader({ className, ...props }: ModuleHeaderProps) {
  return <div className={classNames('module-head', className)} {...props} />;
}

export type ModuleTitleProps = ComponentPropsWithoutRef<'h2'>;

export function ModuleTitle({ className, ...props }: ModuleTitleProps) {
  return <h2 className={classNames('module-title', className)} {...props} />;
}

export type ModuleSubtitleProps = ComponentPropsWithoutRef<'p'>;

export function ModuleSubtitle({ className, ...props }: ModuleSubtitleProps) {
  return <p className={classNames('module-sub', className)} {...props} />;
}

export type ModuleToolsProps = ComponentPropsWithoutRef<'div'>;

export function ModuleTools({ className, ...props }: ModuleToolsProps) {
  return <div className={classNames('module-tools', className)} {...props} />;
}
