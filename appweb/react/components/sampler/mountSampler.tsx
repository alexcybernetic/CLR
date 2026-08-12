import { createRef, memo, useCallback } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import {
  type DisplayCoordinator,
  type SamplerSelectionMode,
} from '../../../runtime/displayCoordinator.ts';
import type { HelpWindowController } from '../../help/helpController.ts';
import { useExternalStoreSnapshot } from '../../runtime/useExternalStoreSnapshot.ts';
import { SamplerContent } from './Sampler.tsx';

export interface MountSamplerOptions {
  readonly display: DisplayCoordinator;
  readonly help: HelpWindowController;
  /** Called after a user-originated enabled-state change reaches the coordinator. */
  readonly onEnabledChange?: (enabled: boolean) => void;
  /** Called after a user-originated selection change reaches the coordinator. */
  readonly onSelectionModeChange?: (mode: SamplerSelectionMode) => void;
  /** Called after a user-originated speed change reaches the coordinator. */
  readonly onSpeedChange?: (speed: number) => void;
}

export interface MountedSampler {
  /** Permanent renderer host committed by the synchronous initial render. */
  readonly canvas: HTMLCanvasElement;
  readonly dispose: () => void;
}

type ConnectedSamplerProps = MountSamplerOptions & {
  readonly canvasRef: React.RefObject<HTMLCanvasElement | null>;
};

const StableSamplerContent = memo(SamplerContent);

function ConnectedSampler({
  canvasRef,
  display,
  help,
  onEnabledChange,
  onSelectionModeChange,
  onSpeedChange,
}: ConnectedSamplerProps) {
  const snapshot = useExternalStoreSnapshot(display).sampler;
  const helpSnapshot = useExternalStoreSnapshot(help);

  const setEnabled = useCallback((enabled: boolean) => {
    display.setSamplerEnabled(enabled);
    onEnabledChange?.(enabled);
  }, [display, onEnabledChange]);

  const setSelectionMode = useCallback((mode: SamplerSelectionMode) => {
    display.setSelectionMode(mode);
    onSelectionModeChange?.(mode);
  }, [display, onSelectionModeChange]);

  const setSpeed = useCallback((speed: number) => {
    display.setSamplerSpeed(speed);
    onSpeedChange?.(speed);
  }, [display, onSpeedChange]);

  const nextPair = useCallback(() => display.nextPair(), [display]);
  const rewind = useCallback(() => display.rewindSampler(), [display]);
  const step = useCallback(() => display.stepSampler(), [display]);
  const toggleRunning = useCallback(() => {
    const sampler = display.getSnapshot().sampler;
    if (sampler.enabled) display.setSamplerRunning(!sampler.running);
  }, [display]);
  const toggleHelp = useCallback(() => help.toggle('sampler'), [help]);

  return (
    <StableSamplerContent
      snapshot={snapshot}
      canvasRef={canvasRef}
      helpPressed={helpSnapshot.open && helpSnapshot.topic === 'sampler'}
      onEnabledChange={setEnabled}
      onHelp={toggleHelp}
      onNextPair={nextPair}
      onRewind={rewind}
      onSelectionModeChange={setSelectionMode}
      onSpeedChange={setSpeed}
      onStep={step}
      onToggleRunning={toggleRunning}
    />
  );
}

/**
 * Mount the production Sampler synchronously. Its committed canvas can be
 * attached to DisplayCoordinator before any renderer or startup query runs.
 */
export function mountSampler(
  container: HTMLElement,
  options: MountSamplerOptions,
): MountedSampler {
  const root = createRoot(container);
  const canvasRef = createRef<HTMLCanvasElement>();

  flushSync(() => root.render(
    <ConnectedSampler {...options} canvasRef={canvasRef} />,
  ));

  const canvas = canvasRef.current;
  if (!canvas) {
    root.unmount();
    throw new Error('Sampler mount did not commit its canvas');
  }

  let mounted = true;
  return {
    canvas,
    dispose: () => {
      if (!mounted) return;
      mounted = false;
      root.unmount();
    },
  };
}
