import type {
  MouseEventHandler,
  PointerEventHandler,
  Ref,
} from 'react';
import { createPortal } from 'react-dom';

import type {
  SamplerSelectionMode,
  SoupDisplayMode,
} from '../../../runtime/displayCoordinator.ts';
import { CLASS_CSS, KEY_ROWS, VALUE_STOPS } from '../../../ui/palette.ts';
import { SOUP_VIEW_OPTIONS } from '../../model/controlOptions.ts';
import { Button, HelpButton } from '../primitives/Button.tsx';
import { ModuleHeader, ModuleTitle, ModuleTools } from '../primitives/Module.tsx';
import { SegmentedControl } from '../primitives/SegmentedControl.tsx';

export interface SoupProps {
  readonly canvasRef?: Ref<HTMLCanvasElement>;
  readonly screenRef?: Ref<HTMLDivElement>;
  readonly dragging: boolean;
  readonly expanded: boolean;
  readonly helpPressed: boolean;
  readonly legendContainer: HTMLElement;
  readonly mode: SoupDisplayMode;
  readonly selectionMode: SamplerSelectionMode;
  readonly viewNote: string;
  readonly onDoubleClick: MouseEventHandler<HTMLDivElement>;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly onFit: () => void;
  readonly onHelp: () => void;
  readonly onModeChange: (mode: SoupDisplayMode) => void;
  readonly onPointerCancel: PointerEventHandler<HTMLDivElement>;
  readonly onPointerDown: PointerEventHandler<HTMLDivElement>;
  readonly onPointerMove: PointerEventHandler<HTMLDivElement>;
  readonly onPointerUp: PointerEventHandler<HTMLDivElement>;
}

function SoupLegends() {
  return (
    <>
      <div className="soup-key-mode" id="soupOpsKey">
        {KEY_ROWS.map((row) => (
          <span key={row.what}>
            <i style={{ background: CLASS_CSS[row.cls] }} />
            {row.glyphs ? <em>{row.glyphs}</em> : null}
            {row.what}
          </span>
        ))}
      </div>
      <div className="soup-key-mode value-key">
        <em>byte values</em>
        <span className="value-items">
          {VALUE_STOPS.map((stop) => (
            <span className="value-item" key={stop.value}>
              <i
                aria-hidden="true"
                style={{ background: `rgb(${stop.rgb.join(',')})` }}
              />
              <b>{stop.value}</b>
            </span>
          ))}
        </span>
      </div>
    </>
  );
}

/** Complete declarative contents of the stable production Soup host. */
export function Soup({
  canvasRef,
  screenRef,
  dragging,
  expanded,
  helpPressed,
  legendContainer,
  mode,
  selectionMode,
  viewNote,
  onDoubleClick,
  onExpandedChange,
  onFit,
  onHelp,
  onModeChange,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: SoupProps) {
  const options = SOUP_VIEW_OPTIONS.map((option) => ({
    ...option,
    disabled: option.value === 'counts' && selectionMode === 'pick',
  }));

  return (
    <>
      <ModuleHeader>
        <ModuleTitle>soup</ModuleTitle>
        <ModuleTools>
          <SegmentedControl
            data-ctl="mode"
            ariaLabel="soup display mode"
            options={options}
            value={mode}
            onChange={onModeChange}
          />
          <Button id="btnSoupFit" disabled={mode === 'counts'} onClick={onFit}>fit</Button>
          <Button
            id="btnSoupExpand"
            aria-pressed={expanded}
            onClick={() => onExpandedChange(!expanded)}
          >
            expand
          </Button>
        </ModuleTools>
        <HelpButton
          topic="soup"
          pressed={helpPressed}
          aria-label="help: soup"
          onClick={onHelp}
        />
      </ModuleHeader>
      <div
        ref={screenRef}
        className={dragging ? 'screen dragging' : 'screen'}
        id="soupScreen"
        onDoubleClick={onDoubleClick}
        onPointerCancel={onPointerCancel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <canvas id="soupCanvas" ref={canvasRef} />
        <div className="scan" aria-hidden="true" />
        <div className="vig" aria-hidden="true" />
        <span className="screen-note" id="soupView">{viewNote}</span>
      </div>
      {createPortal(<SoupLegends />, legendContainer)}
    </>
  );
}
