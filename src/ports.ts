import type { ConnectionFields, ConnectionRecord, QueryResult } from './schema.js';
import type { InspectResult } from './inspect.js';

/** Application ports: host storage, secrets and tool registration stay outside the manager. */
export interface ConnectionStore {
  entries(): IterableIterator<[string, ConnectionRecord]>;
  get(id: string): ConnectionRecord | undefined;
  put(id: string, value: ConnectionRecord): Promise<void>;
  delete(id: string): Promise<boolean>;
}
export interface SecretStore {
  read(ref: string): Promise<string>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
}
export interface ConnectionRunner {
  inspect?(input: unknown, signal?: AbortSignal, scope?: string): Promise<InspectResult>;
  query(sql: string, signal?: AbortSignal): Promise<QueryResult>;
  mongo(input: unknown, signal?: AbortSignal): Promise<QueryResult>;
  test(signal?: AbortSignal): Promise<QueryResult>;
  close(): Promise<void>;
}
export type RunnerFactory = (
  config: ConnectionFields,
  password: () => Promise<string>,
) => ConnectionRunner;
export type MountTool = (
  record: ConnectionRecord,
  runner: ConnectionRunner,
) => Promise<() => Promise<void>>;
