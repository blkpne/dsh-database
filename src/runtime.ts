import { DatabaseError } from './errors.js';
import type { ConnectionRecord } from './schema.js';
import type { ConnectionRunner, MountTool, RunnerFactory, SecretStore } from './ports.js';

interface Runtime {
  runner: ConnectionRunner;
  dispose: () => Promise<void>;
}

/** Owns active, starting and retiring tools until every cleanup has settled. */
export class ConnectionRuntimes {
  private active = new Map<string, Runtime>();
  private failedCleanup = new Map<string, Runtime>();
  private starting = new Map<string, Promise<void>>();
  private stopping = new Map<string, Promise<void>>();
  private errors = new Map<string, string>();
  private closed = false;
  private closing?: Promise<void>;

  constructor(
    private readonly secrets: SecretStore,
    private readonly mount: MountTool,
    private readonly createRunner: RunnerFactory,
  ) {}

  status(id: string): { status: 'enabled' | 'disabled' | 'error'; error?: string } {
    const error = this.errors.get(id);
    return error
      ? { status: 'error', error }
      : { status: this.active.has(id) ? 'enabled' : 'disabled' };
  }

  start(record: ConnectionRecord): Promise<void> {
    if (!record.enabled || this.closed || this.active.has(record.id)) return Promise.resolve();
    const pending = this.starting.get(record.id);
    if (pending) return pending;
    const task = this.activate(record).finally(() => this.starting.delete(record.id));
    this.starting.set(record.id, task);
    return task;
  }

  private async activate(record: ConnectionRecord): Promise<void> {
    await this.stopping.get(record.id);
    if (this.failedCleanup.has(record.id))
      throw new DatabaseError(
        'CLEANUP_FAILED',
        '旧连接资源尚未回收，不能重新启用。请重试停用或重新加载插件。',
      );
    if (this.closed) return;
    if (this.failedCleanup.size >= 20)
      throw new DatabaseError(
        'CLEANUP_FAILED',
        '未完成清理的连接已达上限，请重新加载插件并检查清理错误。',
      );
    const runner = this.createRunner(record, async () =>
      record.passwordRef ? this.secrets.read(record.passwordRef) : '',
    );
    let dispose: () => Promise<void>;
    try {
      dispose = await this.mount(record, runner);
    } catch (error) {
      await runner.close();
      this.errors.set(
        record.id,
        error instanceof DatabaseError
          ? error.message
          : 'MCP 工具注册失败，请停用后重试或检查宿主兼容版本。',
      );
      return;
    }
    if (this.closed) {
      // This is teardown, not activation failure: propagate it to every waiting close caller.
      await this.dispose({ runner, dispose });
      return;
    }
    this.active.set(record.id, { runner, dispose });
    this.errors.delete(record.id);
  }

  private async dispose(runtime: Runtime): Promise<void> {
    // Cancel first, unregister in the same turn, and retain ownership through both cleanups.
    const outcomes = await Promise.allSettled([
      runtime.runner.close(),
      Promise.resolve().then(() => runtime.dispose()),
    ]);
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  stop(id: string): Promise<void> {
    const pending = this.stopping.get(id);
    if (pending) return pending;
    const retire = async () => {
      await this.starting.get(id);
      const runtime = this.active.get(id) ?? this.failedCleanup.get(id);
      this.active.delete(id);
      this.errors.delete(id);
      if (runtime) {
        try {
          await this.dispose(runtime);
          this.failedCleanup.delete(id);
        } catch {
          this.failedCleanup.set(id, runtime);
          this.errors.set(id, '连接资源清理失败，请重新加载插件后重试。');
          throw new DatabaseError('CLEANUP_FAILED', '连接资源清理失败，请重新加载插件后重试。');
        }
      }
    };
    const task = retire().finally(() => this.stopping.delete(id));
    this.stopping.set(id, task);
    return task;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const ids = new Set([
      ...this.active.keys(),
      ...this.failedCleanup.keys(),
      ...this.starting.keys(),
      ...this.stopping.keys(),
    ]);
    this.closing = (async () => {
      const outcomes = await Promise.allSettled([...ids].map((id) => this.stop(id)));
      const failure = outcomes.find((outcome) => outcome.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    })();
    return this.closing;
  }
}
