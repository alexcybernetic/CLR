import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ApplicationHeader } from './ApplicationHeader.tsx';

describe('ApplicationHeader', () => {
  it('secures new-tab links and gives icon-only links accessible names', () => {
    const { container } = render(
      <ApplicationHeader version="fixture" helpPressed={false} onHelp={() => undefined} />,
    );

    const newTabLinks = [...container.querySelectorAll<HTMLAnchorElement>('a[target="_blank"]')];
    expect(newTabLinks.length).toBeGreaterThan(0);
    for (const link of newTabLinks) {
      expect(link.rel.split(/\s+/)).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
    }

    const community = container.querySelector('nav');
    expect(community).not.toBeNull();
    expect(community?.getAttribute('aria-label')?.trim()).toBeTruthy();
    const communityLinks = [...(community?.querySelectorAll<HTMLAnchorElement>('a') ?? [])];
    expect(communityLinks.length).toBeGreaterThan(0);
    for (const link of communityLinks) {
      expect(link.getAttribute('aria-label')?.trim()).toBeTruthy();
    }
  });
});
