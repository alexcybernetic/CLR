import { useCallback, useLayoutEffect, useRef } from 'react';

import {
  FloatingWindow,
  type FloatingWindowBox,
  type FloatingWindowIds,
} from '../components/windows/index.ts';
import { useExternalStoreSnapshot } from '../runtime/index.ts';
import type { HelpWindowController } from './helpController.ts';
import { HELP_TOPICS, HELP_TOPICS_BY_ID } from './helpTopics.tsx';

const HELP_WINDOW_IDS = {
  window: 'helpWin',
  bar: 'helpBar',
  title: 'helpTitle',
  close: 'helpClose',
  navigation: 'helpNav',
  body: 'helpBody',
} satisfies FloatingWindowIds;

export interface HelpWindowProps {
  readonly controller: HelpWindowController;
  readonly resolveFocusFallback?: () => HTMLElement | null;
}

/** React-owned manual window backed by the framework-independent Help controller. */
export function HelpWindow({ controller, resolveFocusFallback }: HelpWindowProps) {
  const snapshot = useExternalStoreSnapshot(controller);
  const bodyRef = useRef<HTMLDivElement>(null);
  const topic = HELP_TOPICS_BY_ID[snapshot.topic];

  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [snapshot.contentRevision, snapshot.topic]);

  const close = useCallback(() => controller.close(), [controller]);
  const setBox = useCallback(
    (box: FloatingWindowBox) => controller.setBox(box),
    [controller],
  );

  return (
    <FloatingWindow
      open={snapshot.open}
      ariaLabel="reactor manual"
      caption="reactor manual"
      title={topic.title}
      navigation={HELP_TOPICS.map((candidate) => (
        <button
          key={candidate.id}
          className={candidate.id === snapshot.topic ? 'on' : undefined}
          type="button"
          data-topic={candidate.id}
          aria-pressed={candidate.id === snapshot.topic}
          onClick={() => controller.open(candidate.id)}
        >
          {candidate.title}
        </button>
      ))}
      closeLabel="close reactor manual"
      ids={HELP_WINDOW_IDS}
      bodyRef={bodyRef}
      initialBox={snapshot.hasExplicitPosition
        ? snapshot.box
        : { w: snapshot.box.w, h: snapshot.box.h }}
      resolveFocusFallback={resolveFocusFallback}
      onClose={close}
      onBoxChange={setBox}
    >
      {topic.content}
    </FloatingWindow>
  );
}
