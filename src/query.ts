import { connectionFields, DatabaseError, safeError } from './schema.js';
import type { ConnectionFields, QueryResult } from './schema.js';
import { probes } from './engines.js';
import { validateReadOnlySql } from './sql.js';
import { validateMongoQuery } from './mongo.js';
import type { MongoQuery } from './mongo.js';
import type { Adapter } from './adapters/types.js';
import type { AdapterInput } from './adapters/types.js';
import { Inspector, MAX_METADATA_ROWS } from './inspect.js';
import { effectivePolicy } from './policy.js';
import { stage, cancellation, callContext } from './observability.js';
import { abortable } from './adapters/types.js';
import { ResultCollector } from './result.js';
export { MAX_RESULT_BYTES } from './result.js';

import { loadAdapter } from './adapters/index.js';
import type { QueryCapacity } from './limits.js';
export { loadAdapter } from './adapters/index.js';

/** Every query owns its driver connection; close waits for owned cleanup, including late connects. */
export class QueryRunner {
  private active = new Map<AbortController, Promise<void>>();
  private closed = false;
  private inspector: Inspector;
  constructor(
    private config: ConnectionFields,
    private password: () => Promise<string>,
    private adapter = loadAdapter,
    private options: { capacity?: QueryCapacity; maxConcurrent?: number } = {},
  ) {
    this.config = { ...connectionFields.parse(config), port: config.port };
    this.options = { ...options };
    this.inspector = new Inspector(this.config, (input, signal) => this.run(input, signal));
  }
  async close(): Promise<void> {
    this.closed = true;
    this.inspector.clear();
    for (const request of this.active.keys()) request.abort();
    await Promise.allSettled(this.active.values());
  }
  async query(sql: string, parent?: AbortSignal): Promise<QueryResult> {
    stage('validation');
    this.assertQuery();
    if (this.config.engine === 'mongodb')
      return Promise.reject(
        new DatabaseError('INVALID_INPUT', 'MongoDB 使用结构化只读查询，不接受 SQL。'),
      );
    return this.run(validateReadOnlySql(sql, this.config.engine), parent);
  }
  async mongo(input: unknown, parent?: AbortSignal): Promise<QueryResult> {
    stage('validation');
    this.assertQuery();
    if (this.config.engine !== 'mongodb')
      return Promise.reject(new DatabaseError('INVALID_INPUT', '此连接接受 SQL 查询。'));
    return this.run(validateMongoQuery(input), parent);
  }
  test(parent?: AbortSignal): Promise<QueryResult> {
    return this.config.engine === 'mongodb'
      ? this.run({ operation: 'listCollections' }, parent)
      : this.run(probes[this.config.engine], parent);
  }
  inspect(input: unknown, signal?: AbortSignal, scope?: string) {
    if (this.closed) throw new DatabaseError('CONNECTION_DISABLED', '连接已停用。');
    return this.inspector.inspect(input, signal, scope);
  }
  private assertQuery(): void {
    if (effectivePolicy(this.config.policy).mode === 'metadata')
      throw new DatabaseError('POLICY_DENIED', '此连接只允许结构发现，不允许查询业务数据。');
  }
  private async run(input: AdapterInput, parent?: AbortSignal): Promise<QueryResult> {
    if (this.closed) throw new DatabaseError('CONNECTION_DISABLED', '连接已停用，请重新开启工具。');
    if (parent?.aborted) throw new DatabaseError('CANCELED', '查询已取消。');
    if (this.active.size >= (this.options.maxConcurrent ?? 2))
      throw new DatabaseError('BUSY', '此连接查询并发已达上限，请稍后重试。');
    const release = this.options.capacity?.acquire();
    const abort = new AbortController();
    const trace = callContext.getStore();
    abort.signal.addEventListener('abort', () => cancellation(false, trace), { once: true });
    let done!: () => void;
    this.active.set(
      abort,
      new Promise<void>((resolve) => {
        done = resolve;
      }),
    );
    const onParent = () => {
      cancellation();
      abort.abort();
    };
    parent?.addEventListener('abort', onParent, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      cancellation();
      abort.abort();
    }, this.config.timeoutMs);
    try {
      // No resources exist yet; a stalled secret provider/import must not block cancellation.
      const [password, execute] = await abortable(
        Promise.all([
          (async () => {
            stage('credentials');
            const value = await this.password();
            stage('credentials-ready');
            return value;
          })(),
          (async () => {
            stage('driver-load');
            const value = await this.adapter(this.config.engine);
            stage('driver-ready');
            return value;
          })(),
        ]),
        abort.signal,
        () => {},
      );
      abort.signal.throwIfAborted();
      const result = new ResultCollector(
        typeof input !== 'string' && 'kind' in input
          ? MAX_METADATA_ROWS
          : typeof input === 'string'
            ? this.config.maxRows
            : Math.min(input.limit ?? this.config.maxRows, this.config.maxRows),
      );
      stage('connect-auth');
      await execute(input, { config: this.config, password, signal: abort.signal, result });
      abort.signal.throwIfAborted();
      return result.finish();
    } catch (error) {
      if (abort.signal.aborted)
        throw new DatabaseError(
          timedOut ? 'TIMEOUT' : 'CANCELED',
          timedOut ? '查询超时，已发出取消请求。请缩小查询范围或提高超时。' : '查询已取消。',
        );
      const safe = safeError(error);
      throw new DatabaseError(safe.code, safe.message);
    } finally {
      stage('cleanup');
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParent);
      this.active.delete(abort);
      release?.();
      done();
    }
  }
}
