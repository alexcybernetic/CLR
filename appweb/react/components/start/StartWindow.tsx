import { type KeyboardEvent, useRef, useState } from 'react';

import { Brand } from '../Brand.tsx';
import { Button } from '../primitives/Button.tsx';

export interface StartWindowProps {
  version: string;
  onStart: () => void;
}

const FOCUSABLE_SELECTOR = 'a[href], button:not(:disabled)';

/** Required preflight shown before the application controller is started. */
export function StartWindow({ version, onStart }: StartWindowProps) {
  const submittedRef = useRef(false);
  const [submitted, setSubmitted] = useState(false);

  function submitStart(): void {
    if (submittedRef.current) return;
    submittedRef.current = true;
    setSubmitted(true);
    onStart();
  }

  function containKeyboardFocus(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.key !== 'Tab') return;

    const dialog = event.currentTarget.querySelector<HTMLElement>('#startWindow');
    if (!dialog) return;

    const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="start-layer" id="startLayer" onKeyDown={containKeyboardFocus}>
      <section
        className="start-window"
        id="startWindow"
        role="dialog"
        aria-modal="true"
        aria-labelledby="startTitle"
        aria-describedby="startClaim startLicenseNotice"
      >
        <div className="start-light" aria-hidden="true" />
        <header className="start-brand">
          <Brand version={version} variant="start" titleId="startTitle" />
        </header>

        <p className="start-claim" id="startClaim">
          Emergence of self-replicators from randomness and simple interactions.
        </p>

        <div className="start-license" id="startLicenseNotice">
          <p>
            <strong>Free software · GNU GPL v3.0 or later</strong>
          </p>
          <p>You may run, study, modify, and redistribute CLR under that license.</p>
          <p>CLR comes without any warranty.</p>
        </div>

        <nav className="start-links" aria-label="project and license information">
          <a
            id="startLicenseLink"
            href="./LICENSE.txt"
            target="_blank"
            rel="noopener noreferrer"
          >
            full license
          </a>
          <a
            id="startNoticesLink"
            href="./THIRD_PARTY_NOTICES.md"
            target="_blank"
            rel="noopener noreferrer"
          >
            third-party notices
          </a>
          <a
            href="https://github.com/alexcybernetic/CLR"
            target="_blank"
            rel="noopener noreferrer"
          >
            source
          </a>
        </nav>

        <footer className="start-footer">
          <span>Copyright © 2026 Alex Borger</span>
          <Button
            className="start-button"
            id="btnStart"
            autoFocus
            disabled={submitted}
            aria-busy={submitted}
            onClick={submitStart}
          >
            I understand — start CLR
          </Button>
        </footer>
      </section>
    </div>
  );
}
