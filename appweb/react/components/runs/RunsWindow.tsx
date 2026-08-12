import type { KeyboardEvent, ReactNode } from 'react';

import type { ComputePath } from '../../../../engine/src/protocol.ts';
import type { ReactorEngine } from '../../../../engine/src/soup.ts';
import { MAX_BATCH_EPOCH_LIMIT, MAX_BATCH_RUNS, MAX_SEED } from '../../../records/batch.ts';
import type {
  BatchDefinition,
  BatchRunDefinition,
  OrderCrossing,
} from '../../../records/model.ts';
import { formatMutationRate, mutationRateToSlider, mutationSliderToRate } from '../../../ui/formatMutationRate.ts';
import {
  COMPUTE_PATH_OPTIONS,
  ENGINE_OPTIONS,
  STEP_LIMIT_OPTIONS,
  TAPE_COUNT_OPTIONS,
  TAPE_LENGTH_OPTIONS,
  type ControlOption,
} from '../../model/controlOptions.ts';
import { Button } from '../primitives/Button.tsx';
import { Field } from '../primitives/Field.tsx';
import { Module, ModuleHeader, ModuleTitle } from '../primitives/Module.tsx';
import { Switch } from '../primitives/Switch.tsx';
import { FloatingWindow, type FloatingWindowIds } from '../windows/FloatingWindow.tsx';
import type {
  BatchEditorState,
  BatchProgress,
  RunsController,
  RunsViewSnapshot,
} from './runsController.ts';

const RUNS_IDS = {
  window: 'runsWin',
  bar: 'runsBar',
  title: 'runsTitle',
  close: 'runsClose',
  navigation: 'runsNav',
  body: 'runsBody',
} satisfies FloatingWindowIds;

function NumberSelect({
  name,
  value,
  options,
  disabled,
  onChange,
}: {
  readonly name: string;
  readonly value: number;
  readonly options: readonly ControlOption<number>[];
  readonly disabled: boolean;
  readonly onChange: (value: number) => void;
}) {
  return (
    <select
      className="sel"
      name={name}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(Number(event.target.value))}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  );
}

function StringSelect<T extends string>({
  name,
  value,
  options,
  disabled,
  optionDisabled,
  onChange,
}: {
  readonly name: string;
  readonly value: T;
  readonly options: readonly ControlOption<T>[];
  readonly disabled: boolean;
  readonly optionDisabled?: (value: T) => boolean;
  readonly onChange: (value: T) => void;
}) {
  return (
    <select
      className="sel"
      name={name}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as T)}
    >
      {options.map((option) => (
        <option
          key={option.value}
          value={option.value}
          disabled={optionDisabled?.(option.value)}
        >
          {option.label}
        </option>
      ))}
    </select>
  );
}

function queueStatus(progress: BatchProgress, index: number): string {
  const item = progress.items[index];
  if (!item) return 'queued';
  if (item.reason) return `${item.reason} at ${item.epoch}`;
  return item.epoch ? `${item.status} at ${item.epoch}` : item.status;
}

function BatchEditor({
  controller,
  snapshot,
}: {
  readonly controller: RunsController;
  readonly snapshot: RunsViewSnapshot;
}) {
  const { editor, batchProgress: progress } = snapshot;
  const locked = progress.active;
  const selected = snapshot.selectedQueueIndex >= 0;
  const update = (patch: Partial<BatchEditorState>) => controller.updateEditor(patch);
  const keySelect = (event: KeyboardEvent<HTMLTableRowElement>, index: number) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    controller.selectQueueIndex(index);
  };
  const runNumber = Math.min(progress.currentRun, progress.totalRuns);
  const canStop = progress.active && (
    progress.phase === 'starting'
    || progress.phase === 'running'
    || progress.phase === 'pausing'
    || progress.phase === 'paused'
    || progress.phase === 'resuming'
  );
  const runSwitchLocked = progress.active && !canStop;

  return (
    <>
      <div className="batch-editor" id="batchEditor">
        <Module className="module-zone">
          <ModuleHeader><ModuleTitle>soup conditions</ModuleTitle></ModuleHeader>
          <div className="module-row">
            <Field caption="engine">
              <StringSelect<ReactorEngine>
                name="engine"
                value={editor.engine}
                options={ENGINE_OPTIONS}
                disabled={locked}
                onChange={(engine) => controller.selectEngine(engine)}
              />
            </Field>
            <Field caption="tapes">
              <NumberSelect
                name="tapes"
                value={editor.nTapes}
                options={TAPE_COUNT_OPTIONS}
                disabled={locked}
                onChange={(nTapes) => update({ nTapes })}
              />
            </Field>
            <Field caption="bytes/tape">
              <NumberSelect
                name="length"
                value={editor.tapeLen}
                options={TAPE_LENGTH_OPTIONS}
                disabled={locked}
                onChange={(tapeLen) => update({ tapeLen })}
              />
            </Field>
            <Field caption="seed start">
              <input
                className="num"
                name="seed"
                type="number"
                min={0}
                max={MAX_SEED}
                step={1}
                value={editor.seed}
                disabled={locked}
                onChange={(event) => update({ seed: event.target.value })}
              />
              <Button id="batchRoll" disabled={locked} onClick={() => controller.rollSeed()}>
                roll
              </Button>
            </Field>
            <Field caption="number of seeds">
              <input
                className="num"
                name="seedCount"
                type="number"
                min={1}
                max={MAX_BATCH_RUNS}
                step={1}
                value={editor.seedCount}
                disabled={locked}
                onChange={(event) => update({ seedCount: event.target.value })}
              />
            </Field>
          </div>
        </Module>

        <Module className="module-zone module-grow">
          <ModuleHeader><ModuleTitle>run conditions</ModuleTitle></ModuleHeader>
          <div className="module-row">
            <Field caption="step limit/program">
              <NumberSelect
                name="steps"
                value={editor.maxSteps}
                options={STEP_LIMIT_OPTIONS}
                disabled={locked}
                onChange={(maxSteps) => update({ maxSteps })}
              />
            </Field>
            <Field caption="compute">
              <StringSelect<ComputePath>
                name="computePath"
                value={editor.computePath}
                options={COMPUTE_PATH_OPTIONS}
                disabled={locked || editor.engine !== 'cubff'}
                optionDisabled={(path) => path === 'webgpu' && !snapshot.webGpuAvailable}
                onChange={(computePath) => update({ computePath })}
              />
            </Field>
            <Field caption="mutation/byte/epoch" className="batch-mutation">
              <input
                className="fader"
                name="mutation"
                type="range"
                min={0}
                max={100}
                value={mutationRateToSlider(editor.mutationRate)}
                disabled={locked}
                onChange={(event) => update({
                  mutationRate: mutationSliderToRate(Number(event.target.value)),
                })}
              />
              <span className="ro" id="batchMutation">
                {formatMutationRate(editor.mutationRate)}
              </span>
            </Field>
            <Field caption="terminate at epoch">
              <input
                className="num"
                name="epochLimit"
                type="number"
                min={1}
                max={MAX_BATCH_EPOCH_LIMIT}
                step={1}
                value={editor.epochLimit}
                disabled={locked}
                onChange={(event) => update({ epochLimit: event.target.value })}
              />
            </Field>
            <Field caption="terminate on order crossing">
              <select
                className="sel"
                name="orderCrossing"
                value={editor.orderCrossing}
                disabled={locked}
                onChange={(event) => update({
                  orderCrossing: Number(event.target.value) as OrderCrossing,
                })}
              >
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
              </select>
            </Field>
            <Field className="batch-editor-actions">
              <Button id="batchAdd" disabled={locked} onClick={() => controller.addEditorRun()}>
                Add
              </Button>
              <Button
                id="batchEdit"
                disabled={locked || !selected}
                onClick={() => controller.editSelectedRun()}
              >
                Edit
              </Button>
            </Field>
          </div>
        </Module>
      </div>

      <p className="batch-error" id="batchError" role="alert">
        {snapshot.editorError}
      </p>

      <div className="batch-queue-head">
        <Field caption="batch name">
          <input
            className="num batch-name"
            id="batchName"
            value={snapshot.batchName}
            disabled={locked}
            onChange={(event) => controller.updateBatchName(event.target.value)}
            onBlur={(event) => controller.updateBatchName(event.target.value, true)}
          />
        </Field>
        <div className="batch-state">
          {progress.active ? (
            <>
              <span>{progress.status}</span>
              <span>run {runNumber} / {progress.totalRuns}</span>
              <span>epoch {progress.currentEpoch}</span>
            </>
          ) : progress.totalRuns ? (
            <span>
              last batch {progress.status}, {progress.completedRuns} / {progress.totalRuns} completed
            </span>
          ) : (
            <span>idle</span>
          )}
        </div>
        <Button
          className="btn-red"
          id="batchClear"
          disabled={locked || snapshot.queue.length === 0}
          onClick={() => {
            if (window.confirm(`Clear all ${snapshot.queue.length} runs from the draft queue?`)) {
              controller.clearQueue();
            }
          }}
        >
          Clear queue
        </Button>
        <Button
          className="btn-red"
          id="batchStop"
          disabled={!canStop}
          onClick={() => {
            if (window.confirm('Stop this batch at the next exact epoch boundary?')) {
              controller.stopBatch();
            }
          }}
        >
          Stop batch
        </Button>
        <Switch
          id="batchRun"
          scale="lg"
          label="run"
          checked={progress.active && progress.running}
          disabled={runSwitchLocked || (!progress.active && snapshot.queue.length === 0)}
          onCheckedChange={(running) => controller.setBatchRunning(running)}
        />
      </div>

      <div className="records-table-wrap batch-queue">
        <table className="records-table">
          <thead>
            <tr>
              <th>#</th><th>engine</th><th>compute</th><th>tapes</th><th>bytes</th>
              <th>seed</th><th>steps</th><th>mutation</th><th>epoch limit</th>
              <th>order crossing</th><th>status</th><th />
            </tr>
          </thead>
          <tbody>
            {snapshot.queue.length ? snapshot.queue.map((queued, index) => (
              <tr
                key={`${index}:${queued.config.seed}`}
                data-queue-index={index}
                tabIndex={0}
                className={index === snapshot.selectedQueueIndex ? 'selected' : undefined}
                onClick={() => controller.selectQueueIndex(index)}
                onKeyDown={(event) => keySelect(event, index)}
              >
                <td>{index + 1}</td>
                <td>{queued.config.engine}</td>
                <td>{queued.computePath}</td>
                <td>{queued.config.nTapes}</td>
                <td>{queued.config.tapeLen}</td>
                <td>{queued.config.seed}</td>
                <td>{queued.config.maxSteps}</td>
                <td>{formatMutationRate(queued.config.mutationRate)}</td>
                <td>{queued.epochLimit}</td>
                <td>{queued.orderCrossing}</td>
                <td>{queueStatus(progress, index)}</td>
                <td>
                  <Button
                    className="btn-red batch-delete"
                    data-delete-index={index}
                    aria-label={`delete queued run ${index + 1}`}
                    disabled={locked}
                    onClick={(event) => {
                      event.stopPropagation();
                      controller.deleteQueueIndex(index);
                    }}
                  >
                    Delete
                  </Button>
                </td>
              </tr>
            )) : (
              <tr><td colSpan={12}>Queue is empty. Configure one run and press Add.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function formatTime(value: number | null): string {
  return value === null ? '—' : new Date(value).toLocaleString();
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function wilson95(successes: number, total: number): [number, number] | null {
  if (total < 1) return null;
  const z = 1.959963984540054;
  const z2 = z * z;
  const proportion = successes / total;
  const denominator = 1 + z2 / total;
  const center = (proportion + z2 / (2 * total)) / denominator;
  const margin = (z / denominator) * Math.sqrt(
    (proportion * (1 - proportion)) / total + z2 / (4 * total * total),
  );
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

type SnapshotRun = RunsViewSnapshot['records']['runs'][number];
type SnapshotExperiment = RunsViewSnapshot['records']['experiments'][number];

interface ExperimentGroup {
  readonly item: BatchRunDefinition;
  readonly runs: SnapshotRun[];
  queued: number;
}

function ExperimentSummary({
  experiment,
  runById,
}: {
  readonly experiment: SnapshotExperiment;
  readonly runById: ReadonlyMap<string, SnapshotRun>;
}) {
  const definition = experiment.definition as BatchDefinition & {
    configs?: unknown;
    seeds?: unknown;
  };
  if (!Array.isArray(definition.items)) {
    return (
      <section className="experiment-summary">
        <h4>{experiment.name} <span>{experiment.status}</span></h4>
        <p>Legacy generated batch. Its executed runs remain available in the records table and exports.</p>
      </section>
    );
  }

  const groups = new Map<string, ExperimentGroup>();
  definition.items.forEach((item, index) => {
    const config = item.config;
    const key = JSON.stringify([
      config.engine,
      item.computePath,
      config.nTapes,
      config.tapeLen,
      config.maxSteps,
      config.mutationRate,
      item.epochLimit,
      item.orderCrossing,
    ]);
    const group = groups.get(key) ?? { item, runs: [], queued: 0 };
    group.queued++;
    const run = runById.get(experiment.runIds[index]);
    if (run) group.runs.push(run);
    groups.set(key, group);
  });

  return (
    <section className="experiment-summary">
      <h4>{experiment.name} <span>{experiment.status}</span></h4>
      <p>{definition.items.length} explicitly configured runs</p>
      <div className="records-table-wrap">
        <table className="records-table experiment-table">
          <thead>
            <tr>
              <th>engine</th><th>compute</th><th>shape</th><th>steps</th>
              <th>mutation</th><th>epoch limit</th><th>order crossing</th>
              <th>completed</th><th>crossing 95% CI</th>
              <th>first epoch median (range)</th><th>steps median</th><th>compute median</th>
            </tr>
          </thead>
          <tbody>
            {[...groups.entries()].map(([key, { item, runs, queued }]) => {
              const completed = runs.filter((run) => run.status === 'completed');
              const crossings = completed.filter((run) => run.firstThresholdCrossing !== null);
              const interval = wilson95(crossings.length, completed.length);
              const crossingRate = completed.length
                ? `${((100 * crossings.length) / completed.length).toFixed(1)} %${interval
                  ? ` [${(100 * interval[0]).toFixed(1)}, ${(100 * interval[1]).toFixed(1)}]`
                  : ''}`
                : '—';
              const epochs = crossings.map((run) => run.firstThresholdCrossing?.epoch ?? 0);
              const epochMedian = median(epochs);
              const epochRange = epochs.length
                ? `${Math.min(...epochs)}–${Math.max(...epochs)}`
                : '—';
              const stepMedian = median(crossings.map(
                (run) => run.firstThresholdCrossing?.steps ?? 0,
              ));
              const timeMedian = median(crossings.map(
                (run) => run.firstThresholdCrossing?.computeMs ?? 0,
              ));
              const config = item.config;
              return (
                <tr key={key}>
                  <td>{config.engine}</td>
                  <td>{item.computePath}</td>
                  <td>{config.nTapes} × {config.tapeLen}</td>
                  <td>{config.maxSteps}</td>
                  <td>{formatMutationRate(config.mutationRate)}</td>
                  <td>{item.epochLimit}</td>
                  <td>{item.orderCrossing}</td>
                  <td>{completed.length} / {queued}</td>
                  <td>{crossingRate}</td>
                  <td>{epochMedian === null ? '—' : `${Math.round(epochMedian)} (${epochRange})`}</td>
                  <td>{stepMedian === null ? '—' : Math.round(stepMedian)}</td>
                  <td>{timeMedian === null ? '—' : `${(timeMedian / 1000).toFixed(1)} s`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RecordsView({ controller, snapshot }: {
  readonly controller: RunsController;
  readonly snapshot: RunsViewSnapshot;
}) {
  const { records } = snapshot;
  if (records.status === 'idle' || records.status === 'loading') {
    return <p>Reading local records…</p>;
  }
  if (records.status === 'failed') {
    return <p role="alert">Local records could not be read: {records.error}</p>;
  }
  const runById = new Map(records.runs.map((run) => [run.id, run]));
  return (
    <>
      <div className="records-tools">
        <Button id="recordsJson" onClick={() => void controller.exportAllJson()}>
          export JSON
        </Button>
        <Button id="recordsCsv" onClick={() => controller.exportCsv()}>
          export CSV summary
        </Button>
        <span>{records.runs.length} runs, {records.experiments.length} batches</span>
      </div>
      {records.experiments.map((experiment) => (
        <ExperimentSummary key={experiment.id} experiment={experiment} runById={runById} />
      ))}
      <div className="records-table-wrap">
        <table className="records-table">
          <thead>
            <tr>
              <th>started</th><th>source</th><th>status</th><th>engine</th>
              <th>compute</th><th>shape</th><th>seed</th><th>epoch</th><th>max H</th><th />
            </tr>
          </thead>
          <tbody>
            {records.runs.length ? records.runs.map((run) => (
              <tr key={run.id}>
                <td>{formatTime(run.startedAt)}</td>
                <td>{run.source}</td>
                <td>{run.status}</td>
                <td>{run.initialConfig.engine}</td>
                <td>{run.execution.computePath}</td>
                <td>{run.initialConfig.nTapes} × {run.initialConfig.tapeLen}</td>
                <td>{run.initialConfig.seed}</td>
                <td>{run.finalEpoch}</td>
                <td>{run.maximumHighOrder?.toFixed(3) ?? '—'}</td>
                <td>
                  <button
                    type="button"
                    className="runs-link"
                    data-export-run={run.id}
                    onClick={() => void controller.exportRunJson(run.id)}
                  >
                    JSON
                  </button>
                </td>
              </tr>
            )) : (
              <tr><td colSpan={10}>No executed runs recorded.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

export interface RunsWindowProps {
  readonly controller: RunsController;
  readonly snapshot: RunsViewSnapshot;
  readonly resolveFocusFallback?: () => HTMLElement | null;
}

/** Complete React-owned batch editor and records window. */
export function RunsWindow({
  controller,
  snapshot,
  resolveFocusFallback,
}: RunsWindowProps) {
  const navigation: ReactNode = (
    <>
      <button
        type="button"
        data-runs-tab="batch"
        className={snapshot.tab === 'batch' ? 'on' : undefined}
        aria-pressed={snapshot.tab === 'batch'}
        onClick={() => controller.setTab('batch')}
      >
        batch
      </button>
      <button
        type="button"
        data-runs-tab="records"
        className={snapshot.tab === 'records' ? 'on' : undefined}
        aria-pressed={snapshot.tab === 'records'}
        onClick={() => controller.setTab('records')}
      >
        records
      </button>
    </>
  );

  return (
    <FloatingWindow
      open={snapshot.open}
      ariaLabel="experiment runs"
      caption="runs"
      title={snapshot.tab === 'batch' ? 'sequential batch' : 'local records'}
      navigation={navigation}
      className="runswin"
      bodyClassName="runswin-body"
      closeLabel="close experiment runs"
      ids={RUNS_IDS}
      initialBox={{ w: 1180, h: 700 }}
      initialSide="left"
      resolveFocusFallback={resolveFocusFallback}
      onClose={() => controller.close()}
    >
      {snapshot.tab === 'batch'
        ? <BatchEditor controller={controller} snapshot={snapshot} />
        : <RecordsView controller={controller} snapshot={snapshot} />}
    </FloatingWindow>
  );
}
