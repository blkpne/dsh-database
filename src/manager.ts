import { randomBytes } from 'node:crypto';
import { connectionInput, DatabaseError, safeError } from './schema.js';
import type { ConnectionFields, ConnectionRecord, QueryResult } from './schema.js';
import { QueryRunner } from './query.js';
import { accessPolicy, effectivePolicy } from './policy.js';
import { Observatory, stage } from './observability.js';

import { ConnectionRuntimes } from './runtime.js';
import { QueryCapacity, runtimeLimits } from './limits.js';
import type { RuntimeLimits } from './limits.js';
import type {
  ConnectionRunner,
  ConnectionStore,
  SecretStore,
  MountTool,
  RunnerFactory,
} from './ports.js';
export type { ConnectionStore, SecretStore, MountTool } from './ports.js';

export type PublicConnection = Omit<ConnectionRecord, 'passwordRef'> & {
  hasPassword: boolean;
  toolName: string;
  inspectToolName: string;
  effectivePolicy: ReturnType<typeof effectivePolicy>;
  status: 'enabled' | 'disabled' | 'error';
  error?: string;
};
export const toolName = (id: string) => `mcp__dshdb_${id}__query`;
export class CommittedMutationError extends DatabaseError {
  constructor(
    error: unknown,
    readonly connectionId: string,
    readonly connections: PublicConnection[],
  ) {
    const safe = safeError(error);
    super(safe.code, `配置变更已提交。${safe.message}`);
  }
}

export class ConnectionManager {
  readonly observations: Observatory;
  scopeChoices: () => { id: string; workspace?: string; createdAt?: number; child?: boolean }[] =
    () => [];
  private readonly runtimes: ConnectionRuntimes;
  private readonly createRunner: RunnerFactory;
  private readonly limits: RuntimeLimits;
  private pendingTests = new Map<ConnectionRunner, { id?: string; done: Promise<void> }>();
  private changing = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private pendingMutations = 0;
  private closed = false;
  private closing?: Promise<void>;
  constructor(
    private store: ConnectionStore,
    private secrets: SecretStore,
    mount: MountTool,
    options: Partial<RuntimeLimits> = {},
    createRunner?: RunnerFactory,
    observations = new Observatory(),
  ) {
    this.observations = observations;
    this.limits = runtimeLimits.parse(options);
    const capacity = new QueryCapacity(this.limits.maxConcurrentQueries);
    this.createRunner =
      createRunner ??
      ((config, password) =>
        new QueryRunner(config, password, undefined, {
          capacity,
          maxConcurrent: this.limits.maxQueriesPerConnection,
        }));
    this.runtimes = new ConnectionRuntimes(secrets, mount, this.createRunner);
  }

  private serialize<T>(operation: () => Promise<T>, id?: string): Promise<T> {
    if (this.closed) return Promise.reject(new DatabaseError('CLOSED', '插件已卸载。'));
    if (this.pendingMutations >= this.limits.maxPendingMutations)
      return Promise.reject(new DatabaseError('BUSY', '待处理配置操作已达上限，请稍后重试。'));
    this.pendingMutations++;
    const task = this.queue
      .then(async () => {
        if (this.closed) throw new DatabaseError('CLOSED', '插件已卸载。');
        if (id) this.changing.add(id);
        try {
          return await operation();
        } finally {
          if (id) this.changing.delete(id);
        }
      })
      .finally(() => {
        this.pendingMutations--;
      });
    this.queue = task.catch(() => {});
    return task;
  }
  private require(id: string): ConnectionRecord {
    const record = this.store.get(id);
    if (!record) throw new DatabaseError('NOT_FOUND', '连接不存在，可能已被其他页面删除。');
    return record;
  }
  private assertRevision(record: ConnectionRecord, revision: number): void {
    if (record.revision !== revision)
      throw new DatabaseError('CONFLICT', '连接已被其他页面修改，请刷新后重试。');
  }
  list(): PublicConnection[] {
    return [...this.store.entries()].map(([, record]) => {
      const { passwordRef, ...publicRecord } = record;
      return {
        ...publicRecord,
        effectivePolicy: effectivePolicy(record.policy),
        hasPassword: Boolean(passwordRef),
        toolName: toolName(record.id),
        inspectToolName: `mcp__dshdb_${record.id}__inspect`,
        ...this.runtimes.status(record.id),
      };
    });
  }
  restore(): Promise<void> {
    return this.serialize(async () => {
      for (const [, record] of this.store.entries()) await this.runtimes.start(record);
    });
  }

  save(
    raw: unknown,
    id?: string,
    revision?: number,
  ): Promise<{
    connectionId: string;
    connections: PublicConnection[];
  }> {
    return this.serialize(async () => {
      const previous = id ? this.require(id) : undefined;
      const input = this.parseInput(raw, previous);
      if (previous) this.assertRevision(previous, revision ?? -1);
      if (previous && previous.engine !== input.engine)
        throw new DatabaseError('INVALID_INPUT', '已有连接不能更换数据库类型，请新建连接。');
      if (
        [...this.store.entries()].some(
          ([, value]) =>
            value.id !== id && value.name.toLocaleLowerCase() === input.name.toLocaleLowerCase(),
        )
      ) {
        throw new DatabaseError(
          'DUPLICATE_NAME',
          '连接名称已存在，请使用不同名称，方便 Agent 区分。',
        );
      }
      if (!previous && [...this.store.entries()].length >= 20)
        throw new DatabaseError('LIMIT', '最多支持 20 个连接。');
      const now = new Date().toISOString();
      const { password, clearPassword, ...fields } = input;
      const record: ConnectionRecord = {
        ...fields,
        ...(previous?.policy && !fields.policy ? { policy: previous.policy } : {}),
        ...(!previous && !fields.policy ? { policy: accessPolicy.parse({}) } : {}),
        id: previous?.id ?? randomBytes(8).toString('hex'),
        enabled: previous?.enabled ?? false,
        revision: (previous?.revision ?? 0) + 1,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        ...(previous?.passwordRef ? { passwordRef: previous.passwordRef } : {}),
      };
      let newRef: string | undefined;
      if (clearPassword) delete record.passwordRef;
      else if (password) {
        newRef = `DSH_DATABASE_${randomBytes(16).toString('hex').toUpperCase()}`;
        await this.secrets.set(newRef, password);
        record.passwordRef = newRef;
      }
      try {
        await this.store.put(record.id, record);
      } catch (error) {
        if (newRef) await this.retireSecret(newRef);
        throw error;
      }
      const connections = await this.afterCommit(record.id, async () => {
        try {
          await this.stop(record.id);
          await this.runtimes.start(record);
        } finally {
          if (previous?.passwordRef && previous.passwordRef !== record.passwordRef)
            await this.retireSecret(previous.passwordRef);
        }
      });
      return { connectionId: record.id, connections };
    }, id);
  }
  toggle(id: string, enabled: boolean, revision: number): Promise<PublicConnection[]> {
    return this.serialize(async () => {
      const old = this.require(id);
      this.assertRevision(old, revision);
      const record = {
        ...old,
        enabled,
        revision: old.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      await this.store.put(id, record);
      return this.afterCommit(id, async () => {
        await this.stop(id);
        await this.runtimes.start(record);
      });
    }, id);
  }
  remove(id: string, revision: number): Promise<PublicConnection[]> {
    return this.serialize(async () => {
      const record = this.require(id);
      this.assertRevision(record, revision);
      await this.store.delete(id);
      return this.afterCommit(id, async () => {
        try {
          await this.stop(id);
        } finally {
          if (record.passwordRef) await this.retireSecret(record.passwordRef);
        }
      });
    }, id);
  }
  private parseInput(raw: unknown, previous?: ConnectionRecord) {
    // Omitting TLS while editing must preserve the saved explicit choice.
    return connectionInput.parse(
      previous && raw && typeof raw === 'object' && !Array.isArray(raw)
        ? { tls: previous.tls, ...raw }
        : raw,
    );
  }
  private async retireSecret(ref: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.secrets.delete(ref);
        return;
      } catch {
        /* bounded retry */
      }
    }
    throw new DatabaseError(
      'CREDENTIAL_CLEANUP_FAILED',
      '旧凭据清理失败（已重试 3 次），请检查宿主凭据存储。',
    );
  }
  private async afterCommit(
    id: string,
    operation: () => Promise<void>,
  ): Promise<PublicConnection[]> {
    try {
      await operation();
    } catch (error) {
      throw new CommittedMutationError(error, id, this.list());
    }
    return this.list();
  }
  async test(raw: unknown, id?: string, signal?: AbortSignal): Promise<QueryResult> {
    const old = id ? this.require(id) : undefined;
    const input = this.parseInput(raw, old);
    if (old && old.engine !== input.engine)
      throw new DatabaseError('INVALID_INPUT', '已有连接不能更换数据库类型，请新建连接。');
    const operation = () =>
      this.probe(
        input,
        async () =>
          input.clearPassword
            ? ''
            : input.password || (old?.passwordRef ? await this.secrets.read(old.passwordRef) : ''),
        id,
        (runner) => runner.test(signal),
      );
    if (!old) return operation();
    const draft =
      !!input.password ||
      input.clearPassword ||
      Object.entries(input).some(
        ([key, value]) =>
          !['password', 'clearPassword'].includes(key) &&
          JSON.stringify(value) !== JSON.stringify(old[key as keyof ConnectionRecord]),
      );
    const trace = this.observations.start({
      connectionId: old.id,
      revision: old.revision,
      operation: 'test',
      draft,
    });
    return this.observations.observe(trace, operation);
  }
  async diagnose(id: string, revision: number, signal?: AbortSignal) {
    const record = this.require(id);
    this.assertRevision(record, revision);
    return this.probe(
      record,
      async () => (record.passwordRef ? this.secrets.read(record.passwordRef) : ''),
      id,
      async (runner) => {
        const trace = this.observations.start({
          connectionId: id,
          revision,
          operation: 'diagnose',
        });
        try {
          await this.observations.observe(trace, async () => {
            stage('config');
            await runner.test(signal);
            stage('probe-ok');
            if (runner.inspect) {
              stage('metadata-permissions');
              const result = await runner.inspect(
                { action: 'search', limit: 1, refresh: true },
                signal,
                'diagnostic',
              );
              if (Object.values(result.sections).some((section) => section.status === 'denied'))
                throw new DatabaseError(
                  'METADATA_DENIED',
                  '数据库可连接，但账户没有结构发现权限。',
                );
            }
            stage('diagnostic-complete');
          });
        } catch {
          // Safe categorized failure is in the trace. Never expose driver details through the UI.
        }
        return { trace: structuredClone(trace), observations: this.observations.snapshot(id) };
      },
    );
  }

  private async probe<T>(
    config: ConnectionFields,
    password: () => Promise<string>,
    id: string | undefined,
    operation: (runner: ConnectionRunner) => Promise<T>,
  ): Promise<T> {
    if (this.closed) throw new DatabaseError('CLOSED', '插件已卸载。');
    if (id && this.changing.has(id))
      throw new DatabaseError('BUSY', '连接配置正在更新，请完成后重试。');
    if (this.pendingTests.size >= 2)
      throw new DatabaseError('BUSY', '已有连接测试正在运行，请稍后重试。');
    const runner = this.createRunner(config, password);
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.pendingTests.set(runner, { id, done });
    try {
      return await operation(runner);
    } finally {
      try {
        await runner.close();
      } finally {
        this.pendingTests.delete(runner);
        finish();
      }
    }
  }

  private async stop(id: string): Promise<void> {
    const outcomes = await Promise.allSettled([
      this.runtimes.stop(id),
      ...[...this.pendingTests]
        .filter(([, probe]) => probe.id === id)
        .map(async ([runner, probe]) => {
          await runner.close();
          await probe.done;
        }),
    ]);
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      const outcomes = await Promise.allSettled([
        this.queue,
        this.runtimes.close(),
        ...[...this.pendingTests].map(async ([runner, probe]) => {
          await runner.close();
          await probe.done;
        }),
      ]);
      const failure = outcomes.find((outcome) => outcome.status === 'rejected');
      await this.observations.close();
      if (failure?.status === 'rejected') throw failure.reason;
    })();
    return this.closing;
  }
}
