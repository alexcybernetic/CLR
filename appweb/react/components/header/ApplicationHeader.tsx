import { Brand } from '../Brand.tsx';
import { HelpButton } from '../primitives/Button.tsx';

export interface ApplicationHeaderProps {
  version: string;
  helpPressed: boolean;
  onHelp: () => void;
}

interface SocialLink {
  className: string;
  href: string;
  label: string;
  title: string;
}

const SOCIAL_LINKS: readonly SocialLink[] = [
  {
    className: 'social-link-discord',
    href: 'https://discord.gg/ry9f98PTUE',
    label: 'Join the Discord server',
    title: 'Discord',
  },
  {
    className: 'social-link-github',
    href: 'https://github.com/alexcybernetic',
    label: 'Open Alex Cybernetic on GitHub',
    title: 'GitHub',
  },
  {
    className: 'social-link-x',
    href: 'https://x.com/alexcybernetic',
    label: 'Open Alex Cybernetic on X',
    title: 'X',
  },
  {
    className: 'social-link-bluesky',
    href: 'https://bsky.app/profile/alexborger.com',
    label: 'Open Alex Borger on Bluesky',
    title: 'Bluesky',
  },
  {
    className: 'social-link-youtube',
    href: 'https://youtu.be/w9_fWcNeITg',
    label: 'Watch the CLR video on YouTube',
    title: 'YouTube',
  },
];

const EXTERNAL_LINK_PROPS = {
  target: '_blank',
  rel: 'noopener noreferrer',
} as const;

/** Header descendants rendered into the stable production host. */
export function ApplicationHeaderContent({
  version,
  helpPressed,
  onHelp,
}: ApplicationHeaderProps) {
  return (
    <>
      <div className="brand">
        <Brand version={version} />
      </div>

      <div className="brand-text">
        <p className="brand-claim">
          Emergence of self-replicators from randomness and simple interactions.
        </p>
        <p className="brand-cite">
          Created by <a href="https://alexborger.com" {...EXTERNAL_LINK_PROPS}>Alex Borger</a>.{' '}
          <a href="https://youtu.be/w9_fWcNeITg" {...EXTERNAL_LINK_PROPS}>YouTube video</a> and{' '}
          <a href="https://github.com/mathelehrer/BrainFuckLife" {...EXTERNAL_LINK_PROPS}>C-port Johannes Martin</a>{' '}
          from <a href="https://github.com/paradigms-of-intelligence/cubff" {...EXTERNAL_LINK_PROPS}>CuBFF</a>.{' '}
          <a href="https://arxiv.org/abs/2406.19108" {...EXTERNAL_LINK_PROPS}>After Blaise Agüera y Arcas et al.</a>{' '}
          <a href="https://github.com/alexcybernetic/CLR" {...EXTERNAL_LINK_PROPS}>Source and license</a>.
        </p>
      </div>

      <nav className="social-links" aria-label="community links">
        {SOCIAL_LINKS.map((link) => (
          <a
            key={link.className}
            className={`social-link ${link.className}`}
            href={link.href}
            aria-label={link.label}
            title={link.title}
            {...EXTERNAL_LINK_PROPS}
          />
        ))}
      </nav>

      <HelpButton
        id="btnHelp"
        variant="global"
        topic="fundamentals"
        pressed={helpPressed}
        onClick={onHelp}
      />
    </>
  );
}

/** CLR's global identity, attribution, community links, and manual entry point. */
export function ApplicationHeader(props: ApplicationHeaderProps) {
  return (
    <header className="head">
      <ApplicationHeaderContent {...props} />
    </header>
  );
}
