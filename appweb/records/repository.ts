import {
  type ExperimentRecord,
  type RunEvent,
  type RunMeasurement,
  type RunRecord,
  normalizeExperimentRecord,
  normalizeRunEvent,
  normalizeRunMeasurement,
  normalizeRunRecord,
  validateRunEvent,
  validateExperimentRecord,
  validateRunMeasurement,
  validateRunRecord,
} from './model.ts';

const DATABASE_NAME = 'clr-experiments';
const DATABASE_VERSION = 1;

export interface RunRepository {
  readonly durability: 'indexeddb' | 'memory';
  putRun(record: RunRecord): Promise<void>;
  saveMeasurement(record: RunRecord, measurement: RunMeasurement): Promise<void>;
  saveEvent(record: RunRecord, event: RunEvent): Promise<void>;
  putExperiment(experiment: ExperimentRecord): Promise<void>;
  getExperiment(id: string): Promise<ExperimentRecord | null>;
  listExperiments(): Promise<ExperimentRecord[]>;
  getRun(id: string): Promise<RunRecord | null>;
  listRuns(): Promise<RunRecord[]>;
  listMeasurements(runId: string): Promise<RunMeasurement[]>;
  listEvents(runId: string): Promise<RunEvent[]>;
  markOpenRunsInterrupted(at: number): Promise<number>;
  close(): void;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryRunRepository implements RunRepository {
  readonly durability = 'memory' as const;
  private runs = new Map<string, RunRecord>();
  private measurements = new Map<string, RunMeasurement[]>();
  private events = new Map<string, RunEvent[]>();
  private experiments = new Map<string, ExperimentRecord>();

  async putRun(record: RunRecord): Promise<void> {
    validateRunRecord(record);
    this.runs.set(record.id, clone(record));
  }

  async saveMeasurement(record: RunRecord, measurement: RunMeasurement): Promise<void> {
    validateRunRecord(record);
    validateRunMeasurement(measurement);
    if (record.id !== measurement.runId) throw new Error('measurement belongs to another run');
    const list = this.measurements.get(record.id) ?? [];
    const existing = list.findIndex((item) => item.sequence === measurement.sequence);
    if (existing >= 0) list[existing] = clone(measurement);
    else list.push(clone(measurement));
    list.sort((a, b) => a.sequence - b.sequence);
    this.measurements.set(record.id, list);
    this.runs.set(record.id, clone(record));
  }

  async saveEvent(record: RunRecord, event: RunEvent): Promise<void> {
    validateRunRecord(record);
    validateRunEvent(event);
    if (record.id !== event.runId) throw new Error('event belongs to another run');
    const list = this.events.get(record.id) ?? [];
    const existing = list.findIndex((item) => item.sequence === event.sequence);
    if (existing >= 0) list[existing] = clone(event);
    else list.push(clone(event));
    list.sort((a, b) => a.sequence - b.sequence);
    this.events.set(record.id, list);
    this.runs.set(record.id, clone(record));
  }

  async putExperiment(experiment: ExperimentRecord): Promise<void> {
    validateExperimentRecord(experiment);
    this.experiments.set(experiment.id, clone(experiment));
  }

  async getExperiment(id: string): Promise<ExperimentRecord | null> {
    const experiment = this.experiments.get(id);
    return experiment ? normalizeExperimentRecord(experiment) : null;
  }

  async listExperiments(): Promise<ExperimentRecord[]> {
    return [...this.experiments.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((experiment) => normalizeExperimentRecord(experiment));
  }

  async getRun(id: string): Promise<RunRecord | null> {
    const record = this.runs.get(id);
    return record ? normalizeRunRecord(record) : null;
  }

  async listRuns(): Promise<RunRecord[]> {
    return [...this.runs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((record) => normalizeRunRecord(record));
  }

  async listMeasurements(runId: string): Promise<RunMeasurement[]> {
    return (this.measurements.get(runId) ?? []).map((measurement) =>
      normalizeRunMeasurement(measurement),
    );
  }

  async listEvents(runId: string): Promise<RunEvent[]> {
    return (this.events.get(runId) ?? []).map((event) => normalizeRunEvent(event));
  }

  async markOpenRunsInterrupted(at: number): Promise<number> {
    let changed = 0;
    for (const [id, record] of this.runs) {
      if (record.status !== 'running' && record.status !== 'paused') continue;
      this.runs.set(id, {
        ...record,
        status: 'interrupted',
        endReason: 'interrupted',
        endedAt: at,
        updatedAt: at,
      });
      changed++;
    }
    for (const [id, experiment] of this.experiments) {
      if (
        experiment.status !== 'running' &&
        experiment.status !== 'paused' &&
        experiment.status !== 'queued'
      ) continue;
      this.experiments.set(id, { ...experiment, status: 'interrupted', updatedAt: at });
    }
    return changed;
  }

  close(): void {}
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });
}

export class IndexedDbRunRepository implements RunRepository {
  readonly durability = 'indexeddb' as const;
  private readonly database: IDBDatabase;

  constructor(database: IDBDatabase) {
    this.database = database;
  }

  static async open(): Promise<IndexedDbRunRepository> {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('runs')) {
        const runs = db.createObjectStore('runs', { keyPath: 'id' });
        runs.createIndex('createdAt', 'createdAt');
        runs.createIndex('status', 'status');
        runs.createIndex('source', 'source');
      }
      if (!db.objectStoreNames.contains('measurements')) {
        const measurements = db.createObjectStore('measurements', {
          keyPath: ['runId', 'sequence'],
        });
        measurements.createIndex('runId', 'runId');
      }
      if (!db.objectStoreNames.contains('events')) {
        const events = db.createObjectStore('events', { keyPath: ['runId', 'sequence'] });
        events.createIndex('runId', 'runId');
      }
      if (!db.objectStoreNames.contains('experiments')) {
        db.createObjectStore('experiments', { keyPath: 'id' });
      }
    };
    const database = await requestResult(request);
    database.onversionchange = () => database.close();
    return new IndexedDbRunRepository(database);
  }

  async putRun(record: RunRecord): Promise<void> {
    validateRunRecord(record);
    const transaction = this.database.transaction('runs', 'readwrite');
    transaction.objectStore('runs').put(clone(record));
    await transactionComplete(transaction);
  }

  async saveMeasurement(record: RunRecord, measurement: RunMeasurement): Promise<void> {
    validateRunRecord(record);
    validateRunMeasurement(measurement);
    if (record.id !== measurement.runId) throw new Error('measurement belongs to another run');
    const transaction = this.database.transaction(['runs', 'measurements'], 'readwrite');
    transaction.objectStore('runs').put(clone(record));
    transaction.objectStore('measurements').put(clone(measurement));
    await transactionComplete(transaction);
  }

  async saveEvent(record: RunRecord, event: RunEvent): Promise<void> {
    validateRunRecord(record);
    validateRunEvent(event);
    if (record.id !== event.runId) throw new Error('event belongs to another run');
    const transaction = this.database.transaction(['runs', 'events'], 'readwrite');
    transaction.objectStore('runs').put(clone(record));
    transaction.objectStore('events').put(clone(event));
    await transactionComplete(transaction);
  }

  async putExperiment(experiment: ExperimentRecord): Promise<void> {
    validateExperimentRecord(experiment);
    const transaction = this.database.transaction('experiments', 'readwrite');
    transaction.objectStore('experiments').put(clone(experiment));
    await transactionComplete(transaction);
  }

  async getExperiment(id: string): Promise<ExperimentRecord | null> {
    const transaction = this.database.transaction('experiments', 'readonly');
    const result = await requestResult(transaction.objectStore('experiments').get(id));
    await transactionComplete(transaction);
    return result ? normalizeExperimentRecord(result) : null;
  }

  async listExperiments(): Promise<ExperimentRecord[]> {
    const transaction = this.database.transaction('experiments', 'readonly');
    const result = await requestResult(transaction.objectStore('experiments').getAll());
    await transactionComplete(transaction);
    return (result as unknown[])
      .map((experiment) => normalizeExperimentRecord(experiment))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async getRun(id: string): Promise<RunRecord | null> {
    const transaction = this.database.transaction('runs', 'readonly');
    const result = await requestResult(transaction.objectStore('runs').get(id));
    await transactionComplete(transaction);
    return result ? normalizeRunRecord(result) : null;
  }

  async listRuns(): Promise<RunRecord[]> {
    const transaction = this.database.transaction('runs', 'readonly');
    const result = await requestResult(transaction.objectStore('runs').getAll());
    await transactionComplete(transaction);
    return (result as unknown[])
      .map((record) => normalizeRunRecord(record))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async listMeasurements(runId: string): Promise<RunMeasurement[]> {
    const transaction = this.database.transaction('measurements', 'readonly');
    const result = await requestResult(
      transaction.objectStore('measurements').index('runId').getAll(runId),
    );
    await transactionComplete(transaction);
    return (result as unknown[])
      .map((measurement) => normalizeRunMeasurement(measurement))
      .sort((a, b) => a.sequence - b.sequence);
  }

  async listEvents(runId: string): Promise<RunEvent[]> {
    const transaction = this.database.transaction('events', 'readonly');
    const result = await requestResult(transaction.objectStore('events').index('runId').getAll(runId));
    await transactionComplete(transaction);
    return (result as unknown[])
      .map((event) => normalizeRunEvent(event))
      .sort((a, b) => a.sequence - b.sequence);
  }

  async markOpenRunsInterrupted(at: number): Promise<number> {
    const transaction = this.database.transaction(['runs', 'experiments'], 'readwrite');
    const store = transaction.objectStore('runs');
    const records = (await requestResult(store.getAll()) as unknown[]).map((record) =>
      normalizeRunRecord(record),
    );
    let changed = 0;
    for (const record of records) {
      if (record.status !== 'running' && record.status !== 'paused') continue;
      store.put({
        ...record,
        status: 'interrupted',
        endReason: 'interrupted',
        endedAt: at,
        updatedAt: at,
      } satisfies RunRecord);
      changed++;
    }
    const experimentStore = transaction.objectStore('experiments');
    const experiments = (await requestResult(experimentStore.getAll()) as unknown[]).map(
      (experiment) => normalizeExperimentRecord(experiment),
    );
    for (const experiment of experiments) {
      if (
        experiment.status !== 'running' &&
        experiment.status !== 'paused' &&
        experiment.status !== 'queued'
      ) continue;
      experimentStore.put({ ...experiment, status: 'interrupted', updatedAt: at });
    }
    await transactionComplete(transaction);
    return changed;
  }

  close(): void {
    this.database.close();
  }
}

export async function openRunRepository(): Promise<RunRepository> {
  if (typeof indexedDB === 'undefined') return new MemoryRunRepository();
  try {
    return await IndexedDbRunRepository.open();
  } catch (error) {
    console.warn('[records] IndexedDB unavailable; run records are memory-only.', error);
    return new MemoryRunRepository();
  }
}
