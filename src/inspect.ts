import { z } from 'zod';
import type { ConnectionFields, QueryResult } from './schema.js';
import { truncationReason } from './schema.js';
import { effectivePolicy } from './policy.js';
import { DatabaseError, safeError } from './errors.js';
import { MAX_RESULT_BYTES } from './result.js';
import { engines } from './engines.js';
import { metadataStatements } from './metadata-sql.js';
import { jsonRecord, jsonValue } from './json-schema.js';
export const MAX_METADATA_ROWS = 500;

export const inspectInput = z
  .object({
    action: z.enum(['capabilities', 'namespaces', 'search', 'describe']),
    name: z.string().max(128).optional(),
    schema: z.string().max(128).optional(),
    catalog: z.string().max(128).optional(),
    type: z.enum(['table', 'view', 'collection']).optional(),
    limit: z.number().int().min(1).max(100).default(30),
    offset: z.number().int().min(0).max(100000).default(0),
    refresh: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.action === 'describe' && !v.name)
      ctx.addIssue({ code: 'custom', path: ['name'], message: 'describe 需要精确对象名称。' });
  });
export type InspectInput = z.infer<typeof inspectInput>;
export interface MetadataRequest {
  kind: 'metadata';
  input: InspectInput;
  section: string;
}
export interface SqlStatement {
  kind: 'sql';
  text: string;
  values: string[];
}
const section = z.object({
  status: z.enum(['available', 'empty', 'denied', 'unsupported']),
  columns: z.array(z.string()),
  rows: z.array(z.array(jsonValue)),
  truncated: z.boolean(),
  truncationReason: truncationReason.optional(),
  code: z.string().optional(),
  note: z.string().optional(),
});
export const inspectResult = z.object({
  action: z.enum(['capabilities', 'namespaces', 'search', 'describe']),
  engine: z.string(),
  capabilities: z
    .object({
      dialect: z.string(),
      operations: z.array(z.string()),
      maxRows: z.number(),
      maxMetadataRows: z.number(),
      maxBytes: z.number(),
      timeoutMs: z.number(),
      callsPerMinute: z.number(),
      callsPerHour: z.number(),
      cacheTtlMs: z.number(),
      metadataScope: z.string(),
    })
    .optional(),
  sections: jsonRecord(section),
  nextOffset: z.number().nullable(),
  cache: z.object({ hit: z.boolean(), ageMs: z.number(), ttlMs: z.number() }),
  durationMs: z.number(),
  readOnly: z.literal(true),
});
export type InspectResult = z.infer<typeof inspectResult>;
type ExecuteMetadata = (
  input: SqlStatement | MetadataRequest,
  signal?: AbortSignal,
) => Promise<QueryResult>;
const denied = new Set(['42501', 'ER_TABLEACCESS_DENIED_ERROR', 'ORA-01031', '13', '229']);

/** Per-runtime cache: config/policy changes replace the runner and invalidate every entry. */
export class Inspector {
  private entries = new Map<string, { at: number; bytes: number; value: InspectResult }>();
  private bytes = 0;
  private sequence = 0;
  private latest = new Map<string, number>();
  hits = 0;
  misses = 0;
  constructor(
    private config: ConnectionFields,
    private execute: ExecuteMetadata,
  ) {}
  clear(): void {
    this.entries.clear();
    this.latest.clear();
    this.bytes = 0;
  }
  async inspect(raw: unknown, signal?: AbortSignal, scope = 'transport'): Promise<InspectResult> {
    const input = inspectInput.parse(raw);
    if (signal?.aborted) throw new DatabaseError('CANCELED', '结构发现已取消。');
    const started = Date.now();
    const key = JSON.stringify([scope, { ...input, refresh: false }]);
    const cached = this.entries.get(key);
    if (!input.refresh && cached && started - cached.at < 60000) {
      this.hits++;
      return {
        ...structuredClone(cached.value),
        cache: { hit: true, ageMs: started - cached.at, ttlMs: 60000 },
        durationMs: 0,
      };
    }
    this.misses++;
    const sequence = ++this.sequence;
    this.latest.set(key, sequence);
    try {
      const result: InspectResult = {
        action: input.action,
        engine: this.config.engine,
        sections: {},
        nextOffset: null,
        cache: { hit: false, ageMs: 0, ttlMs: 60000 },
        durationMs: 0,
        readOnly: true,
      };
      if (input.action === 'capabilities') {
        const policy = effectivePolicy(this.config.policy);
        result.capabilities = {
          dialect: engines[this.config.engine].label,
          operations: policy.mode === 'metadata' ? ['inspect'] : ['inspect', 'query'],
          maxRows: this.config.maxRows,
          maxMetadataRows: MAX_METADATA_ROWS,
          maxBytes: MAX_RESULT_BYTES,
          timeoutMs: this.config.timeoutMs,
          callsPerMinute: policy.callsPerMinute,
          callsPerHour: policy.callsPerHour,
          cacheTtlMs: 60000,
          metadataScope:
            this.config.engine === 'mysql' || this.config.engine === 'mariadb'
              ? 'Authorized catalogs; default configured database'
              : 'Current configured database/service; authorized schemas only',
        };
      } else {
        if (
          input.catalog &&
          input.catalog !== this.config.database &&
          !['mysql', 'mariadb'].includes(this.config.engine)
        )
          throw new DatabaseError(
            'UNSUPPORTED_SCOPE',
            '此连接只支持当前数据库的结构发现，请使用对应数据库连接。',
          );
        const configuredNamespace =
          this.config.engine === 'mongodb' && input.action === 'namespaces';
        if (configuredNamespace)
          result.sections.namespaces = {
            status:
              input.offset === 0 && this.config.database.includes(input.name ?? '')
                ? 'available'
                : 'empty',
            columns: ['name'],
            rows:
              input.offset === 0 && this.config.database.includes(input.name ?? '')
                ? [[this.config.database]]
                : [],
            truncated: false,
            note: 'Configured database only. This list is not a connectivity or permission check.',
          };
        const requests = configuredNamespace
          ? []
          : this.config.engine === 'mongodb'
            ? (input.action === 'search' ? ['objects'] : ['collection', 'indexes']).map(
                (section) => ({
                  section,
                  statement: { kind: 'metadata' as const, input, section },
                }),
              )
            : metadataStatements(this.config, input);
        // One invocation has one overall deadline, even when it reads several metadata sections.
        const deadline = AbortSignal.timeout(this.config.timeoutMs);
        const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
        const checkDeadline = () => {
          if (bounded.aborted)
            throw new DatabaseError(
              signal?.aborted ? 'CANCELED' : 'TIMEOUT',
              signal?.aborted ? '结构发现已取消。' : '结构发现超时，请缩小搜索范围。',
            );
        };
        let columnOnly = false;
        const paginated = input.action === 'search' || input.action === 'namespaces';
        for (const request of requests) {
          checkDeadline();
          if (columnOnly) {
            result.sections[request.section] = {
              status: 'denied',
              columns: [],
              rows: [],
              truncated: false,
              code: 'METADATA_PARTIAL',
              note: 'Column-level SELECT only. Whole-object definitions require table-level SELECT to avoid disclosing other columns.',
            };
            continue;
          }
          if (!request.statement) {
            result.sections[request.section] = {
              status: 'unsupported',
              columns: [],
              rows: [],
              truncated: false,
            };
            continue;
          }
          try {
            const value = await this.execute(request.statement, bounded);
            const rows = value.rows;
            if (this.config.engine === 'postgresql' && request.section === 'columns') {
              const permission = value.columns.indexOf('__table_select');
              if (permission >= 0) {
                columnOnly = rows.some((row) => row[permission] === false);
                value.columns.splice(permission, 1);
                for (const row of rows) row.splice(permission, 1);
              }
            }
            if (paginated && rows.length > input.limit) {
              rows.length = input.limit;
              result.nextOffset = input.offset + rows.length;
            } else if (paginated && value.truncated && rows.length)
              result.nextOffset = input.offset + rows.length;
            result.sections[request.section] = {
              status: rows.length || value.truncated ? 'available' : 'empty',
              columns: value.columns.map((v) => v.toLowerCase()),
              rows,
              truncated: value.truncated,
              ...(value.truncationReason ? { truncationReason: value.truncationReason } : {}),
              ...(columnOnly ? { note: 'Only columns with SELECT permission are included.' } : {}),
            };
            if (
              this.config.engine === 'mongodb' &&
              request.section === 'collection' &&
              rows.length
            ) {
              const metadata = rows[0]?.[0] as { options?: { validator?: unknown } } | undefined;
              if (metadata?.options?.validator === undefined)
                result.sections[request.section]!.note =
                  'No validator is defined; document structure is unknown. Documents are not sampled.';
            }
            // Never return an unbounded sum of separately bounded metadata queries.
            while (
              Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES - 512 &&
              rows.length
            ) {
              rows.pop();
              result.sections[request.section]!.truncated = true;
              result.sections[request.section]!.truncationReason = 'byte_limit';
            }
            // If the aggregate byte cap removed rows, continue at the last delivered row.
            if (paginated && result.sections[request.section]!.truncated)
              result.nextOffset = rows.length ? input.offset + rows.length : null;
          } catch (error) {
            checkDeadline();
            const safe = safeError(error);
            if (!denied.has(safe.code)) throw error;
            result.sections[request.section] = {
              status: 'denied',
              columns: [],
              rows: [],
              truncated: false,
              code: safe.code,
            };
          }
        }
        checkDeadline();
      }
      if (signal?.aborted) throw new DatabaseError('CANCELED', '结构发现已取消。');
      result.durationMs = Date.now() - started;
      const bytes = Buffer.byteLength(JSON.stringify(result));
      if (this.latest.get(key) !== sequence) return result;
      this.latest.delete(key);
      const old = this.entries.get(key);
      if (old) {
        this.bytes -= old.bytes;
        this.entries.delete(key);
      }
      while (this.entries.size >= 64 || this.bytes + bytes > 2 * 1024 * 1024) {
        const first = this.entries.keys().next().value;
        if (first === undefined) break;
        this.bytes -= this.entries.get(first)!.bytes;
        this.entries.delete(first);
      }
      this.entries.set(key, { at: Date.now(), bytes, value: structuredClone(result) });
      this.bytes += bytes;
      return result;
    } finally {
      if (this.latest.get(key) === sequence) this.latest.delete(key);
    }
  }
}
