import { useEffect, useRef, useState } from 'react';

import type { ComputePath } from '../../../../engine/src/protocol.ts';
import type { ReactorEngine } from '../../../../engine/src/soup.ts';
import { formatMutationRate, mutationRateToSlider, mutationSliderToRate } from '../../../ui/formatMutationRate.ts';
import type { ControlOption } from '../../model/controlOptions.ts';
import { Button, HelpButton } from '../primitives/Button.tsx';
import { Field } from '../primitives/Field.tsx';
import { Module, ModuleHeader, ModuleTitle, ModuleTools } from '../primitives/Module.tsx';
import { SegmentedControl } from '../primitives/SegmentedControl.tsx';
import { StatusRow, StatusValue } from '../primitives/StatusRow.tsx';
import { Switch } from '../primitives/Switch.tsx';

export interface ControlDeckOption<T extends string | number> extends ControlOption<T> {
  readonly disabled?: boolean;
  readonly hidden?: boolean;
}

export interface ControlDeckViewState {
  readonly engine: ReactorEngine;
  readonly engineOptions: readonly ControlOption<ReactorEngine>[];
  readonly computePath: ComputePath;
  readonly computeOptions: readonly ControlDeckOption<ComputePath>[];
  readonly computeDisabled: boolean;
  readonly computeError: string | null;
  readonly computeErrorRevision: number;
  readonly workers: string;
  readonly workerOptions: readonly ControlDeckOption<string>[];
  readonly workersDisabled: boolean;
  readonly nTapes: number;
  readonly tapeCountOptions: readonly ControlOption<number>[];
  readonly tapeLen: number;
  readonly tapeLengthOptions: readonly ControlOption<number>[];
  readonly seed: number;
  readonly maxSteps: number;
  readonly stepLimitOptions: readonly ControlOption<number>[];
  readonly mutationRate: number;
  readonly rateLimit: number;
  readonly rateOptions: readonly ControlOption<number>[];
  readonly running: boolean;
  readonly runsOpen: boolean;
  readonly runsDisabled: boolean;
  readonly modelControlsDisabled: boolean;
  readonly mutationDisabled: boolean;
  readonly rateDisabled: boolean;
  readonly runDisabled: boolean;
  readonly resetDisabled: boolean;
  readonly computeStatus: string;
  readonly computeStatusTitle: string;
  readonly epochsPerSecond: string;
  readonly epoch: string;
}

export interface ControlDeckHelpState {
  readonly open: boolean;
  readonly topic: string;
}

export interface ControlDeckActions {
  readonly onEngineChange: (engine: ReactorEngine) => void;
  readonly onComputePathChange: (path: ComputePath) => void;
  readonly onWorkersChange: (value: string) => void;
  readonly onTapeCountChange: (value: number) => void;
  readonly onTapeLengthChange: (value: number) => void;
  readonly onSeedChange: (value: number) => void;
  readonly onRandomizeSeed: () => void;
  readonly onStepLimitChange: (value: number) => void;
  readonly onMutationRateInput: (value: number) => void;
  readonly onMutationRateCommit: () => void;
  readonly onRateLimitChange: (value: number) => void;
  readonly onRunningChange: (running: boolean) => void;
  readonly onRestart: () => void;
  readonly onToggleRuns: () => void;
  readonly onDefaults: () => void;
  readonly onHelp: (topic: string) => void;
}

export interface ControlDeckProps {
  readonly state: Readonly<ControlDeckViewState>;
  readonly help: Readonly<ControlDeckHelpState>;
  readonly actions: ControlDeckActions;
}

function numericOptions(options: readonly ControlOption<number>[]) {
  return options.map((option) => (
    <option key={option.value} value={option.value}>{option.label}</option>
  ));
}

/** Complete declarative setup and run-control deck. */
export function ControlDeck({ state, help, actions }: ControlDeckProps) {
  const [seedDraft, setSeedDraft] = useState(String(state.seed));
  const computeRef = useRef<HTMLSelectElement>(null);
  const reportedComputeError = useRef(0);

  useEffect(() => setSeedDraft(String(state.seed)), [state.seed]);

  useEffect(() => {
    const control = computeRef.current;
    if (!control) return;
    control.setCustomValidity(state.computeError ?? '');
    if (
      state.computeError &&
      state.computeErrorRevision !== reportedComputeError.current
    ) {
      reportedComputeError.current = state.computeErrorRevision;
      control.reportValidity();
    }
  }, [state.computeError, state.computeErrorRevision]);

  const commitSeed = () => {
    const value = Number(seedDraft);
    if (!Number.isFinite(value) || value < 0) {
      setSeedDraft(String(state.seed));
      return;
    }
    actions.onSeedChange(value >>> 0);
  };

  return (
    <div className="module-row module-row-stretch">
      <Module as="div" className="module-zone" data-core-controls>
        <ModuleHeader>
          <ModuleTitle>compute</ModuleTitle>
          <ModuleTools />
          <HelpButton
            topic="compute"
            pressed={help.open && help.topic === 'compute'}
            aria-label="help: compute"
            onClick={() => actions.onHelp('compute')}
          />
        </ModuleHeader>
        <div className="module-row">
          <Field caption="engine" labelFor="selEngine">
            <select
              className="sel"
              id="selEngine"
              autoComplete="off"
              data-lock-running=""
              value={state.engine}
              disabled={state.modelControlsDisabled}
              onChange={(event) => actions.onEngineChange(event.currentTarget.value as ReactorEngine)}
            >
              {state.engineOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </Field>
          <Field caption="compute" labelFor="selCompute">
            <select
              className="sel"
              id="selCompute"
              ref={computeRef}
              autoComplete="off"
              data-lock-running=""
              value={state.computePath}
              disabled={state.computeDisabled}
              title={state.computeError ?? undefined}
              aria-invalid={state.computeError ? true : undefined}
              onChange={(event) => actions.onComputePathChange(event.currentTarget.value as ComputePath)}
            >
              {state.computeOptions.map((option) => (
                <option
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  hidden={option.hidden}
                >
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
          <Field caption="workers" labelFor="selWorkers">
            <select
              className="sel"
              id="selWorkers"
              autoComplete="off"
              data-lock-running=""
              value={state.workers}
              disabled={state.workersDisabled}
              onChange={(event) => actions.onWorkersChange(event.currentTarget.value)}
            >
              {state.workerOptions.map((option) => (
                <option
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  hidden={option.hidden}
                >
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Module>

      <Module as="div" className="module-zone" data-core-controls>
        <ModuleHeader>
          <ModuleTitle>soup conditions</ModuleTitle>
          <ModuleTools />
          <HelpButton
            topic="conditions"
            pressed={help.open && help.topic === 'conditions'}
            aria-label="help: soup conditions"
            onClick={() => actions.onHelp('conditions')}
          />
        </ModuleHeader>
        <div className="module-row">
          <Field caption="tapes" labelFor="selTapes">
            <select
              className="sel"
              id="selTapes"
              autoComplete="off"
              data-lock-running=""
              value={state.nTapes}
              disabled={state.modelControlsDisabled}
              onChange={(event) => actions.onTapeCountChange(Number(event.currentTarget.value))}
            >
              {numericOptions(state.tapeCountOptions)}
            </select>
          </Field>
          <Field caption="bytes/tape" labelFor="selLen">
            <select
              className="sel"
              id="selLen"
              autoComplete="off"
              data-lock-running=""
              value={state.tapeLen}
              disabled={state.modelControlsDisabled}
              onChange={(event) => actions.onTapeLengthChange(Number(event.currentTarget.value))}
            >
              {numericOptions(state.tapeLengthOptions)}
            </select>
          </Field>
          <Field caption="random seed" labelFor="inSeed">
            <input
              className="num"
              id="inSeed"
              autoComplete="off"
              type="number"
              min={0}
              step={1}
              data-lock-running=""
              value={seedDraft}
              disabled={state.modelControlsDisabled}
              onChange={(event) => setSeedDraft(event.currentTarget.value)}
              onBlur={commitSeed}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />
            <Button
              id="btnReseed"
              data-lock-running=""
              disabled={state.modelControlsDisabled}
              onClick={actions.onRandomizeSeed}
            >
              roll
            </Button>
          </Field>
        </div>
      </Module>

      <Module as="div" className="module-zone module-grow" data-core-controls>
        <ModuleHeader>
          <ModuleTitle>run controls</ModuleTitle>
          <ModuleTools>
            <Button
              id="btnRuns"
              aria-pressed={state.runsOpen}
              disabled={state.runsDisabled}
              onClick={actions.onToggleRuns}
            >
              batch runs
            </Button>
            <div style={{ width: 20 }} />
            <Button
              id="btnDefaults"
              title="put every soup parameter back to the baseline configuration"
              data-lock-running=""
              disabled={state.modelControlsDisabled}
              onClick={actions.onDefaults}
            >
              defaults
            </Button>
            <div style={{ width: 20 }} />
          </ModuleTools>
          <HelpButton
            topic="run"
            pressed={help.open && help.topic === 'run'}
            aria-label="help: run controls"
            onClick={() => actions.onHelp('run')}
          />
        </ModuleHeader>
        <div className="module-row">
          <Field caption="step limit/program" labelFor="selSteps">
            <select
              className="sel"
              id="selSteps"
              autoComplete="off"
              data-lock-running=""
              value={state.maxSteps}
              disabled={state.modelControlsDisabled}
              onChange={(event) => actions.onStepLimitChange(Number(event.currentTarget.value))}
            >
              {numericOptions(state.stepLimitOptions)}
            </select>
          </Field>
          <Field caption="mutation/byte/epoch" labelFor="inMut">
            <input
              className="fader"
              id="inMut"
              type="range"
              min={0}
              max={100}
              value={mutationRateToSlider(state.mutationRate)}
              autoComplete="off"
              disabled={state.mutationDisabled}
              onChange={(event) => actions.onMutationRateInput(
                mutationSliderToRate(Number(event.currentTarget.value)),
              )}
              onPointerUp={actions.onMutationRateCommit}
              onBlur={actions.onMutationRateCommit}
              onKeyUp={actions.onMutationRateCommit}
            />
            <span className="ro" id="roMut">{formatMutationRate(state.mutationRate)}</span>
          </Field>
          <Field caption="epochs/second" push>
            <SegmentedControl
              data-ctl="rate"
              ariaLabel="epochs per second"
              options={state.rateOptions}
              value={state.rateLimit}
              disabled={state.rateDisabled}
              onChange={actions.onRateLimitChange}
            />
          </Field>
          <div className="field">
            <div className="field-row">
              <Switch
                id="swRun"
                scale="lg"
                checked={state.running}
                label="run"
                disabled={state.runDisabled}
                onCheckedChange={actions.onRunningChange}
              />
              <Button
                className="btn-red"
                id="btnReset"
                disabled={state.resetDisabled}
                onClick={actions.onRestart}
              >
                restart
              </Button>
            </div>
          </div>
          <div className="status">
            <StatusRow caption="compute">
              <StatusValue
                className="status-compute"
                id="computeTag"
                title={state.computeStatusTitle}
              >
                {state.computeStatus}
              </StatusValue>
            </StatusRow>
            <StatusRow caption="epochs/second">
              <StatusValue id="rateTag">{state.epochsPerSecond}</StatusValue>
            </StatusRow>
            <StatusRow caption="epoch">
              <div className="seg" id="segEpoch"><span className="seg-live">{state.epoch}</span></div>
            </StatusRow>
          </div>
        </div>
      </Module>
    </div>
  );
}
