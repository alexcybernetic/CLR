import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react';

import { GLYPH, OP_CLASS, OP_DESCRIPTION } from '../../../../engine/src/opcodes.ts';
import { CLASS_CSS } from '../../../ui/palette.ts';
import type { MotifSummaryViewState } from '../../runtime/viewState.ts';
import { HelpButton } from '../primitives/Button.tsx';
import { ModuleHeader, ModuleTitle, ModuleTools } from '../primitives/Module.tsx';
import type { ReactionStateSnapshot } from './reactionStateStore.ts';

export interface ReactionStateProps {
  readonly snapshot: ReactionStateSnapshot;
  readonly onLayoutChange?: () => void;
}

export interface ReactionStatePanelProps extends ReactionStateProps {
  readonly helpPressed: boolean;
  readonly onHelp: () => void;
}

const formatInteger = (value: number): string => String(Math.round(value));

function metric(value: number | null, suffix = ''): string {
  return value === null ? '—' : `${formatInteger(value)}${suffix}`;
}

function copyState(motif: Readonly<MotifSummaryViewState>, tapeLen: number): string {
  if (!motif.carriers) return 'untested';
  const fraction = motif.copiedBytes / tapeLen;
  return fraction >= 0.5 ? 'high' : fraction > 0 ? 'some' : 'none';
}

function copiedRun(motif: Readonly<MotifSummaryViewState>, tapeLen: number): string {
  if (!motif.carriers) return '—';
  const copied = Number.isInteger(motif.copiedBytes)
    ? String(motif.copiedBytes)
    : motif.copiedBytes.toFixed(1);
  return `${copied}/${tapeLen}`;
}

function sequenceKey(bytes: readonly number[]): string {
  return bytes.join(',');
}

interface ReplicatorListProps {
  readonly motifs: readonly Readonly<MotifSummaryViewState>[];
  readonly total: number;
  readonly tapeLen: number;
  readonly onLayoutChange?: () => void;
}

function ReplicatorList({ motifs, total, tapeLen, onLayoutChange }: ReplicatorListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLElement>(null);
  const dragging = useRef(false);
  const thumbGrabY = useRef(0);

  const updateScrollbar = useCallback(() => {
    const list = listRef.current;
    const rail = railRef.current;
    const thumb = thumbRef.current;
    if (!list || !rail || !thumb) return;

    const overflow = list.scrollHeight > list.clientHeight + 1;
    rail.hidden = !overflow;
    if (!overflow) return;

    const trackHeight = rail.clientHeight;
    const thumbHeight = Math.max(18, trackHeight * (list.clientHeight / list.scrollHeight));
    const maximumScroll = list.scrollHeight - list.clientHeight;
    const travel = trackHeight - thumbHeight;
    const thumbTop = maximumScroll > 0 ? (list.scrollTop / maximumScroll) * travel : 0;
    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${thumbTop}px)`;
  }, []);

  useLayoutEffect(() => {
    if (motifs.length === 0 && listRef.current) listRef.current.scrollTop = 0;
    updateScrollbar();
    onLayoutChange?.();
  }, [motifs, onLayoutChange, updateScrollbar]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const observer = new ResizeObserver(updateScrollbar);
    observer.observe(list);
    return () => observer.disconnect();
  }, [updateScrollbar]);

  const startThumbDrag = (event: ReactPointerEvent<HTMLElement>) => {
    dragging.current = true;
    thumbGrabY.current = event.clientY - event.currentTarget.getBoundingClientRect().top;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const moveThumb = (event: ReactPointerEvent<HTMLElement>) => {
    if (!dragging.current) return;
    const list = listRef.current;
    const rail = railRef.current;
    if (!list || !rail) return;
    const track = rail.getBoundingClientRect();
    const thumbHeight = event.currentTarget.getBoundingClientRect().height;
    const travel = track.height - thumbHeight;
    const maximumScroll = list.scrollHeight - list.clientHeight;
    if (travel <= 0 || maximumScroll <= 0) return;
    const fraction = (event.clientY - thumbGrabY.current - track.top) / travel;
    list.scrollTop = Math.max(0, Math.min(1, fraction)) * maximumScroll;
  };

  const stopThumbDrag = () => {
    dragging.current = false;
  };

  const pageList = (event: ReactPointerEvent<HTMLDivElement>) => {
    const list = listRef.current;
    const thumb = thumbRef.current;
    if (!list || !thumb || event.target === thumb) return;
    const direction = event.clientY < thumb.getBoundingClientRect().top ? -1 : 1;
    list.scrollTop += direction * list.clientHeight;
    event.preventDefault();
  };

  return (
    <div className="reps-scroll">
      <div
        className="reps-list"
        id="repList"
        ref={listRef}
        role="list"
        aria-label="most frequent 8-byte sequences"
        tabIndex={0}
        onScroll={updateScrollbar}
      >
        {motifs.map((motif) => (
          <div key={sequenceKey(motif.bytes)} role="listitem">
            <span className="rep-seq">
              {motif.bytes.map((byte, index) => (
                <i
                  key={index}
                  style={OP_DESCRIPTION[byte] ? { color: CLASS_CSS[OP_CLASS[byte]] } : undefined}
                >
                  {GLYPH[byte] || '·'}
                </i>
              ))}
            </span>
            <span className="rep-count">{formatInteger(motif.count)}</span>
            <span className="rep-share">
              {total ? `${((100 * motif.count) / total).toFixed(2)} %` : '—'}
            </span>
            <span className="rep-copies" data-state={copyState(motif, tapeLen)}>
              {copiedRun(motif, tapeLen)}
            </span>
          </div>
        ))}
      </div>
      <div
        className="reps-scrollbar"
        id="repScrollRail"
        ref={railRef}
        aria-hidden="true"
        hidden
        onPointerDown={pageList}
      >
        <i
          id="repScrollThumb"
          ref={thumbRef}
          onPointerDown={startThumbDrag}
          onPointerMove={moveThumb}
          onPointerUp={stopThumbDrag}
          onPointerCancel={stopThumbDrag}
        />
      </div>
    </div>
  );
}

interface TerminationRow {
  readonly code: 1 | 2 | 4;
  readonly label: string;
  readonly count: number;
}

/** Declarative body of the existing Reaction State module. */
export function ReactionState({ snapshot, onLayoutChange }: ReactionStateProps) {
  const { config, telemetry } = snapshot;
  const interactions = telemetry.terminations.interactions;
  const terminations: readonly TerminationRow[] = [
    { code: 1, label: 'pointer off tape', count: telemetry.terminations.pointerOffTape },
    { code: 2, label: 'step limit', count: telemetry.terminations.stepLimit },
    { code: 4, label: 'unmatched bracket', count: telemetry.terminations.unmatchedBracket },
  ];

  return (
    <>
      <div className="module-split">
        <div className="tele" id="tele">
          <div><b>dimensions</b><em>{`${formatInteger(config.nTapes)} tapes × ${config.tapeLen} bytes`}</em></div>
          <div>
            <b>largest group of identical tapes</b>
            <em>
              {telemetry.largestIdenticalGroup === null
                ? '—'
                : telemetry.largestIdenticalGroup > 1
                  ? metric(telemetry.largestIdenticalGroup, ' tapes')
                  : 'none'}
            </em>
          </div>
          <div><b>distinct byte values</b><em>{telemetry.distinctBytes === null ? '—' : `${telemetry.distinctBytes} / 256`}</em></div>
          <div>
            <b>distinct tapes</b>
            <em>
              {telemetry.distinctTapes === null
                ? '—'
                : `${formatInteger(telemetry.distinctTapes)} / ${formatInteger(config.nTapes)}`}
            </em>
          </div>
        </div>
        <div className="reps">
          <div className="reps-head">
            <span>most frequent 8-byte sequences</span>
            <span className="reps-copies">copied run</span>
          </div>
          <ReplicatorList
            motifs={telemetry.motifs}
            total={telemetry.motifWindowCount ?? 0}
            tapeLen={config.tapeLen}
            onLayoutChange={onLayoutChange}
          />
        </div>
      </div>
      <div className="halts">
        <span className="halt-cap">termination cause</span>
        <div className="halt-bar" id="haltBar">
          {terminations.map(({ code, count }) => (
            <i
              key={code}
              data-h={code}
              style={{ width: `${interactions ? (100 * count) / interactions : 0}%` }}
            />
          ))}
        </div>
        <div className="halt-key">
          {terminations.map(({ code, label, count }) => (
            <span key={code} data-h={code}>
              <i />{label}
              <b>{interactions ? `${((100 * count) / interactions).toFixed(1)} %` : '—'}</b>
            </span>
          ))}
        </div>
      </div>
    </>
  );
}

/** Complete declarative contents of the stable production Reaction State host. */
export function ReactionStatePanel({
  helpPressed,
  onHelp,
  ...bodyProps
}: ReactionStatePanelProps) {
  return (
    <>
      <ModuleHeader>
        <ModuleTitle>reaction state</ModuleTitle>
        <ModuleTools />
        <HelpButton
          topic="state"
          pressed={helpPressed}
          aria-label="help: reaction state"
          onClick={onHelp}
        />
      </ModuleHeader>
      <div className="reaction-state-body">
        <ReactionState {...bodyProps} />
      </div>
    </>
  );
}
