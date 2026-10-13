import type { QueryResult } from './schema.js';

export const MAX_RESULT_BYTES = 256 * 1024;
export const MAX_CELL_BYTES = 64 * 1024;
const MAX_DEPTH = 30;
// Covers the fixed result envelope, counters and duration (excluding MCP's duplicate text copy).
const ENVELOPE_BYTES = 256;
type Json = QueryResult['rows'][number][number];
type Reason = NonNullable<QueryResult['truncationReason']>;
class ResultLimit extends Error {
  constructor(readonly reason: Reason) {
    super(reason);
  }
}

class Budget {
  used = 0;
  constructor(
    readonly maximum: number,
    readonly reason: Reason = 'byte_limit',
  ) {}
  add(bytes: number): void {
    this.used += bytes;
    if (this.used > this.maximum) throw new ResultLimit(this.reason);
  }
  scalar(value: string | number | boolean | null): void {
    // Reject huge strings before allocating an escaped JSON copy.
    if (typeof value === 'string' && value.length > this.maximum - this.used)
      throw new ResultLimit(this.reason);
    this.add(Buffer.byteLength(JSON.stringify(value)));
  }
}

/** Normalize incrementally; never invoke getters/toJSON or traverse an unbounded document. */
function normalize(value: unknown, budget: Budget, parents: Set<object>, depth = 0): Json {
  if (depth > MAX_DEPTH) throw new ResultLimit('unsupported_value');
  if (value === undefined || value === null) {
    budget.add(4);
    return null;
  }
  if (Buffer.isBuffer(value)) {
    // Base64 expansion is known before allocating its string.
    if (Math.ceil(value.length / 3) * 4 + 31 > budget.maximum - budget.used)
      throw new ResultLimit(budget.reason);
    value = { encoding: 'base64', data: value.toString('base64') };
  }
  if (typeof value === 'bigint') value = value.toString();
  if (value instanceof Date) value = value.toISOString();
  if (typeof value === 'number' && !Number.isFinite(value)) value = String(value);
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    budget.scalar(value);
    return value;
  }
  if (typeof value !== 'object' || value === null || parents.has(value))
    throw new TypeError('Unsupported result value');
  parents.add(value);
  try {
    budget.add(2);
    if (Array.isArray(value)) {
      const output: Json[] = [];
      for (let index = 0; index < value.length; index++) {
        if (index) budget.add(1);
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor && !('value' in descriptor)) throw new TypeError('Accessor in result');
        output.push(normalize(descriptor?.value, budget, parents, depth + 1));
      }
      return output;
    }
    const output: Record<string, Json> = {};
    let first = true;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (!first) budget.add(1);
      first = false;
      budget.scalar(key);
      budget.add(1);
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in descriptor)) throw new TypeError('Accessor in result');
      Object.defineProperty(output, key, {
        value: normalize(descriptor.value, budget, parents, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return output;
  } finally {
    parents.delete(value);
  }
}

/** Preserve column order/duplicates; reject whole rows without throwing from driver callbacks. */
export class ResultCollector {
  columns: string[] = [];
  rows: QueryResult['rows'] = [];
  truncated = false;
  truncationReason?: Reason;
  private truncate(reason: Reason): void {
    this.truncated = true;
    this.truncationReason ??= reason;
  }
  private bytes = ENVELOPE_BYTES;
  private hasFields = false;
  private started = performance.now();
  constructor(private maxRows: number) {}
  fields(columns: string[]): void {
    // A second result set must never reset accounting or relabel previously collected rows.
    if (this.hasFields || this.truncated) {
      this.truncate('unsupported_value');
      return;
    }
    this.hasFields = true;
    try {
      const budget = new Budget(MAX_RESULT_BYTES - this.bytes);
      this.columns = normalize(columns, budget, new Set()) as string[];
      this.bytes += budget.used;
    } catch (error) {
      this.columns = [];
      this.truncate(error instanceof ResultLimit ? error.reason : 'unsupported_value');
    }
  }
  row(values: unknown[]): boolean {
    if (this.truncated) return false;
    if (this.rows.length >= this.maxRows) {
      this.truncate('row_limit');
      return false;
    }
    try {
      let bytes = 2 + (this.rows.length ? 1 : 0);
      const normalized: Json[] = [];
      for (const value of values) {
        if (normalized.length) bytes++;
        const remaining = MAX_RESULT_BYTES - this.bytes - bytes;
        const budget = new Budget(
          Math.min(MAX_CELL_BYTES, remaining),
          remaining < MAX_CELL_BYTES ? 'byte_limit' : 'cell_limit',
        );
        normalized.push(normalize(value, budget, new Set()));
        bytes += budget.used;
      }
      if (this.bytes + bytes > MAX_RESULT_BYTES) throw new ResultLimit('byte_limit');
      this.bytes += bytes;
      this.rows.push(normalized);
      return true;
    } catch (error) {
      this.truncate(error instanceof ResultLimit ? error.reason : 'unsupported_value');
      return false;
    }
  }
  finish(): QueryResult {
    return {
      columns: this.columns,
      rows: this.rows,
      rowCount: this.rows.length,
      truncated: this.truncated,
      ...(this.truncationReason ? { truncationReason: this.truncationReason } : {}),
      durationMs: Math.max(0, Math.round(performance.now() - this.started)),
      readOnly: true,
    };
  }
}
