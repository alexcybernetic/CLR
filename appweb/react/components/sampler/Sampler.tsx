import type { Ref } from 'react';

import type {
  SamplerPresentationSnapshot,
  SamplerSelectionMode,
} from '../../../runtime/displayCoordinator.ts';
import { CLASS_CSS } from '../../../ui/palette.ts';
import { SAMPLER_RATE_OPTIONS, SAMPLE_MODE_OPTIONS } from '../../model/controlOptions.ts';
import { Button, HelpButton } from '../primitives/Button.tsx';
import {
  Module,
  ModuleHeader,
  ModuleTitle,
  ModuleTools,
} from '../primitives/Module.tsx';
import { SegmentedControl } from '../primitives/SegmentedControl.tsx';
import { Switch } from '../primitives/Switch.tsx';

export interface SamplerProps {
  readonly snapshot: Readonly<SamplerPresentationSnapshot>;
  readonly canvasRef?: Ref<HTMLCanvasElement>;
  readonly helpPressed: boolean;
  readonly onEnabledChange: (enabled: boolean) => void;
  readonly onHelp: () => void;
  readonly onNextPair: () => void;
  readonly onRewind: () => void;
  readonly onSelectionModeChange: (mode: SamplerSelectionMode) => void;
  readonly onSpeedChange: (speed: number) => void;
  readonly onStep: () => void;
  readonly onToggleRunning: () => void;
}

/**
 * Sampler descendants rendered into the stable production host. The canvas
 * remains mounted while presentation state moves.
 */
export function SamplerContent({
  snapshot,
  canvasRef,
  helpPressed,
  onEnabledChange,
  onHelp,
  onNextPair,
  onRewind,
  onSelectionModeChange,
  onSpeedChange,
  onStep,
  onToggleRunning,
}: SamplerProps) {
  const nextGlyphColor = snapshot.nextOperationClass === null
    ? undefined
    : CLASS_CSS[snapshot.nextOperationClass];

  return (
    <>
      <ModuleHeader>
        <Switch
          id="swSampler"
          scale="sm"
          checked={snapshot.enabled}
          aria-label="sampler on"
          onCheckedChange={onEnabledChange}
        />
        <ModuleTitle>sampler</ModuleTitle>
        <ModuleTools>
          <span className="lbl">sampling</span>
          <SegmentedControl
            data-ctl="sample"
            ariaLabel="sampling method"
            allowReselect
            disabled={!snapshot.enabled}
            options={SAMPLE_MODE_OPTIONS}
            value={snapshot.selectionMode}
            onChange={onSelectionModeChange}
          />
          <Button
            id="btnLoad"
            disabled={!snapshot.enabled || snapshot.selectionMode === 'pick'}
            onClick={onNextPair}
          >
            next pair
          </Button>

          <Button
            id="btnRxRun"
            className={snapshot.running ? 'on' : undefined}
            aria-pressed={snapshot.running}
            disabled={!snapshot.enabled}
            onClick={onToggleRunning}
          >
            play
          </Button>
          <Button id="btnRxStep" disabled={!snapshot.enabled} onClick={onStep}>step</Button>
          <Button id="btnRxReset" disabled={!snapshot.enabled} onClick={onRewind}>rewind</Button>
          <span className="lbl">steps/frame</span>
          <SegmentedControl
            data-ctl="rxrate"
            ariaLabel="sampler steps per frame"
            disabled={!snapshot.enabled}
            options={SAMPLER_RATE_OPTIONS}
            value={snapshot.speed}
            onChange={onSpeedChange}
          />
        </ModuleTools>
        <HelpButton
          topic="sampler"
          pressed={helpPressed}
          aria-label="help: sampler"
          onClick={onHelp}
        />
      </ModuleHeader>

      <div className="display-shell sampler-display">
        <div className="regs" id="regs">
          <span><b>step</b><em id="rStep">{snapshot.steps} / {snapshot.maxSteps}</em></span>
          <span><b>copies</b><em id="rCopies">{snapshot.copies}</em></span>
          <span><b>ip</b><em id="rIp">{snapshot.ip}</em></span>
          <span><b>h0</b><em id="rH0">{snapshot.h0}</em></span>
          <span><b>h1</b><em id="rH1">{snapshot.h1}</em></span>
          <span>
            <b>next byte</b>
            <em className="next-byte" id="rNextByte">
              <span id="rNextValue">{snapshot.nextByte === null ? '—' : snapshot.nextByte}</span>
              <span id="rNextGlyph" style={{ color: nextGlyphColor }}>{snapshot.nextGlyph}</span>
              <span id="rNextDescription">{snapshot.nextDescription}</span>
            </em>
          </span>
        </div>
        <div className="screen screen-rx">
          <canvas id="reactorCanvas" ref={canvasRef} />
          <div className="scan" aria-hidden="true" />
        </div>
        <div className="tickerrow">
          <span className="ticker-cap">trace</span>
          <span className="ticker" id="ticker">{snapshot.trace}</span>
        </div>
      </div>
    </>
  );
}

/** Complete Sampler module for reusable composition. */
export function Sampler(props: SamplerProps) {
  return (
    <Module className="module-bay bay-reactor module-tool">
      <SamplerContent {...props} />
    </Module>
  );
}
