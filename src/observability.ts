import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { safeError } from './errors.js';

export const traceRecord = z
  .object({
    requestId: z.string(),
    connectionId: z.string(),
    revision: z.number(),
    operation: z.enum(['query', 'inspect', 'diagnose', 'test']),
    draft: z.boolean().optional(),
    callId: z.string().optional(),
    rootCallId: z.string().optional(),
    agentId: z.string().optional(),
    ownerId: z.string().optional(),
    startedAt: z.number(),
    durationMs: z.number(),
    outcome: z.enum([
      'running',
      'success',
      'denied',
      'error',
      'busy',
      'timeout',
      'canceled',
      'interrupted',
    ]),
    code: z.string().optional(),
    stages: z.array(z.object({ name: z.string(), atMs: z.number() })).max(32),
    cancelRequested: z.boolean(),
    driverClosed: z.boolean(),
    serverTermination: z.enum(['not-requested', 'unknown', 'confirmed']),
    cacheHit: z.boolean().optional(),
    finalHostOutcome: z.boolean(),
  })
  .strict();
export type Trace = z.infer<typeof traceRecord>;
export const callContext = new AsyncLocalStorage<Trace>();
export function stage(name: string): void {
  const trace = callContext.getStore();
  if (trace && trace.stages.length < 32)
    trace.stages.push({ name, atMs: Date.now() - trace.startedAt });
}
export function driverClosed(): void {
  const trace = callContext.getStore();
  if (trace) trace.driverClosed = true;
}
export function cancellation(confirmed = false, trace = callContext.getStore()): void {
  if (trace) {
    trace.cancelRequested = true;
    trace.serverTermination = confirmed
      ? 'confirmed'
      : trace.serverTermination === 'confirmed'
        ? 'confirmed'
        : 'unknown';
  }
}
export interface TraceStore {
  entries(): IterableIterator<[string, Trace]>;
  put(key: string, value: Trace): Promise<void>;
  delete(key: string): Promise<boolean>;
}
const outcomeFor = (code?: string): Trace['outcome'] =>
  !code
    ? 'success'
    : /DENIED|UNKNOWN_TOOL|READ_ONLY|FORBIDDEN|HOST_REJECTED/.test(code)
      ? 'denied'
      : code === 'BUSY' || code === 'RATE_LIMITED'
        ? 'busy'
        : /TIMEOUT|57014|NJS-123/.test(code) || code === '50'
          ? 'timeout'
          : /CANCELED|ABORTED|ECANCEL|ORA-01013/.test(code)
            ? 'canceled'
            : 'error';

/** A bounded operational journal, never an SQL log or a business-result store. */
export class Observatory {
  private records = new Map<string, Trace>();
  private running = new Map<string, Trace>();
  private pending = 0;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  dropped = 0;
  writeFailures = 0;
  constructor(private store?: TraceStore) {
    for (const [id, value] of [...(store?.entries() ?? [])].sort(
      (a, b) => a[1].startedAt - b[1].startedAt,
    )) {
      this.records.set(id, {
        ...value,
        outcome: value.outcome === 'running' ? 'interrupted' : value.outcome,
      });
    }
    this.prune();
    // Compact once on open, including when no new request follows a restart.
    this.enqueue(() => this.pruneStore());
  }
  start(
    input: Pick<Trace, 'connectionId' | 'revision' | 'operation'> &
      Partial<Pick<Trace, 'callId' | 'rootCallId' | 'agentId' | 'ownerId' | 'draft'>>,
  ): Trace {
    const trace: Trace = {
      ...input,
      requestId: randomUUID(),
      startedAt: Date.now(),
      durationMs: 0,
      outcome: 'running',
      stages: [],
      cancelRequested: false,
      driverClosed: false,
      serverTermination: 'not-requested',
      finalHostOutcome: false,
    };
    this.records.set(trace.requestId, trace);
    this.running.set(trace.requestId, trace);
    this.persist(trace);
    this.prune();
    return trace;
  }
  finish(trace: Trace, code?: string, finalHostOutcome = false): void {
    trace.durationMs = Date.now() - trace.startedAt;
    // A late driver cleanup must not overwrite an already observed Host cancellation/rejection.
    if (finalHostOutcome || !trace.finalHostOutcome) {
      trace.outcome = outcomeFor(code);
      trace.code = code;
    }
    trace.finalHostOutcome ||= finalHostOutcome;
    this.running.delete(trace.requestId);
    this.persist(trace);
    this.prune();
  }
  private enqueue(task: () => Promise<unknown>): void {
    if (this.closed || !this.store) return;
    if (this.pending >= 128) {
      this.dropped++;
      return;
    }
    this.pending++;
    this.tail = this.tail
      .then(task)
      .then(
        () => {},
        () => {
          this.writeFailures++;
        },
      )
      .finally(() => {
        this.pending--;
      });
  }
  private persist(trace: Trace): void {
    const snapshot = traceRecord.parse(structuredClone(trace));
    this.enqueue(async () => {
      // Prune at the storage boundary too: dropped writes must never grow disk retention.
      await this.store!.put(snapshot.requestId, snapshot);
      await this.pruneStore();
    });
  }
  private async pruneStore(): Promise<void> {
    const entries = [...this.store!.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt);
    let bytes = entries.reduce((sum, [, v]) => sum + Buffer.byteLength(JSON.stringify(v)), 0);
    while (
      entries.length &&
      (entries.length > 2000 ||
        bytes > 8 * 1024 * 1024 ||
        entries[0]![1].startedAt < Date.now() - 7 * 86400000)
    ) {
      const [id, value] = entries.shift()!;
      await this.store!.delete(id);
      bytes -= Buffer.byteLength(JSON.stringify(value));
    }
  }
  private prune(): void {
    let bytes = [...this.records.values()].reduce(
      (sum, value) => sum + Buffer.byteLength(JSON.stringify(value)),
      0,
    );
    let changed = false;
    for (const [id, value] of this.records) {
      if (
        this.records.size <= 2000 &&
        bytes <= 8 * 1024 * 1024 &&
        value.startedAt >= Date.now() - 7 * 86400000
      )
        break;
      this.records.delete(id);
      bytes -= Buffer.byteLength(JSON.stringify(value));
      changed = true;
    }
    if (changed) this.enqueue(() => this.pruneStore());
  }
  snapshot(connectionId: string) {
    this.prune();
    const records = [...this.records.values()].filter((v) => v.connectionId === connectionId);
    const durations = records
      .filter((v) => v.outcome !== 'running')
      .map((v) => v.durationMs)
      .sort((a, b) => a - b);
    const counts: Record<string, number> = {};
    for (const value of records) counts[value.outcome] = (counts[value.outcome] ?? 0) + 1;
    return {
      records: structuredClone(records.slice(-50).reverse()),
      lastProbe: structuredClone(
        records.findLast(
          (record) =>
            record.operation === 'diagnose' || (record.operation === 'test' && !record.draft),
        ),
      ),
      counts,
      active: [...this.running.values()].filter((v) => v.connectionId === connectionId).length,
      p50Ms: durations[Math.floor((durations.length - 1) * 0.5)] ?? 0,
      p95Ms: durations[Math.floor((durations.length - 1) * 0.95)] ?? 0,
      cacheHits: records.filter((v) => v.cacheHit).length,
      journal: {
        dropped: this.dropped,
        writeFailures: this.writeFailures,
        pending: this.pending,
        maxRecords: 2000,
        maxBytes: 8 * 1024 * 1024,
        retentionDays: 7,
      },
    };
  }
  async observe<T>(trace: Trace, operation: () => Promise<T>): Promise<T> {
    return callContext.run(trace, async () => {
      try {
        const value = await operation();
        this.finish(trace);
        return value;
      } catch (error) {
        this.finish(trace, safeError(error).code);
        throw error;
      }
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
  }
}
