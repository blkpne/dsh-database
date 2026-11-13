import type { AccessPolicy } from '../policy.js';
import { engines } from '../engines.js';
import type { Engine } from '../engines.js';
export type Connection = {
  id: string;
  revision: number;
  name: string;
  engine: Engine;
  authSource: string;
  replicaSet: string;
  mongoSrv: boolean;
  host: string;
  port: number;
  user: string;
  database: string;
  tls: boolean;
  maxRows: number;
  timeoutMs: number;
  enabled: boolean;
  hasPassword: boolean;
  toolName: string;
  inspectToolName?: string;
  policy?: AccessPolicy;
  effectivePolicy?: AccessPolicy & { usesDefaultPolicy: boolean };
  status: 'enabled' | 'disabled' | 'error';
  error?: string;
};

export type Draft = Pick<
  Connection,
  'name' | 'host' | 'user' | 'database' | 'engine' | 'authSource' | 'replicaSet' | 'mongoSrv'
> & {
  tls: boolean;
  passwordMode: 'keep' | 'replace' | 'clear';
  policy: AccessPolicy;
  port: number | '';
  maxRows: number | '';
  timeoutMs: number | '';
  password: string;
  clearPassword: boolean;
};

export type SaveResponse = { connectionId: string; connections: Connection[] };

/** Validate the public fields used by the form before adopting a response. */
export function isConnectionList(value: unknown): value is Connection[] {
  const policy = (item: unknown) => {
    if (item === undefined) return true;
    if (!item || typeof item !== 'object') return false;
    const p = item as AccessPolicy;
    return (
      ['host', 'sessions'].includes(p.access) &&
      ['query', 'metadata'].includes(p.mode) &&
      Array.isArray(p.sessionIds) &&
      p.sessionIds.every((id) => typeof id === 'string') &&
      Number.isFinite(p.callsPerMinute) &&
      Number.isFinite(p.callsPerHour)
    );
  };
  return (
    Array.isArray(value) &&
    value.every((item) => {
      if (!item || typeof item !== 'object') return false;
      return (
        ['id', 'name', 'host', 'user', 'database', 'authSource', 'replicaSet', 'toolName'].every(
          (key) => typeof item[key] === 'string',
        ) &&
        Object.hasOwn(engines, item.engine) &&
        Number.isSafeInteger(item.revision) &&
        ['port', 'maxRows', 'timeoutMs'].every((key) => Number.isFinite(item[key])) &&
        ['enabled', 'hasPassword', 'tls', 'mongoSrv'].every(
          (key) => typeof item[key] === 'boolean',
        ) &&
        ['enabled', 'disabled', 'error'].includes(item.status) &&
        ['error', 'inspectToolName'].every(
          (key) => item[key] === undefined || typeof item[key] === 'string',
        ) &&
        policy(item.policy) &&
        policy(item.effectivePolicy)
      );
    })
  );
}

export function savedConnection(response: SaveResponse): Connection {
  const saved = response.connections.find((connection) => connection.id === response.connectionId);
  if (!saved) throw new Error('未收到已保存的连接，请刷新列表核对。');
  return saved;
}

export const emptyDraft = () =>
  ({
    policy: {
      mode: 'query',
      access: 'host',
      sessionIds: [],
      callsPerMinute: 60,
      callsPerHour: 1000,
    },
    name: '',
    engine: 'mysql',
    authSource: '',
    replicaSet: '',
    mongoSrv: false,
    host: 'localhost',
    port: 3306,
    user: '',
    database: '',
    password: '',
    clearPassword: false,
    tls: false,
    passwordMode: 'replace' as const,
    maxRows: 500,
    timeoutMs: 15000,
  }) satisfies Draft;

export const toDraft = (c: Connection): Draft => ({
  policy: c.policy ?? emptyDraft().policy,
  name: c.name,
  engine: c.engine ?? 'mysql',
  authSource: c.authSource ?? '',
  replicaSet: c.replicaSet ?? '',
  mongoSrv: c.mongoSrv ?? false,
  host: c.host,
  port: c.port,
  user: c.user,
  database: c.database,
  tls: c.tls,
  maxRows: c.maxRows,
  timeoutMs: c.timeoutMs,
  password: '',
  clearPassword: false,
  passwordMode: c.hasPassword ? 'keep' : 'replace',
});

export function hasChanges(draft: Draft, connection?: Connection): boolean {
  const baseline = connection ? toDraft(connection) : emptyDraft();
  return (Object.keys(baseline) as (keyof Draft)[]).some(
    (key) => JSON.stringify(draft[key]) !== JSON.stringify(baseline[key]),
  );
}

export const statusLabel = (status: Connection['status']): string =>
  ({ enabled: '已开启', disabled: '已停用', error: '需要处理' })[status];

export function switchEngine(draft: Draft, engine: Engine): Draft {
  return {
    ...draft,
    engine,
    port:
      draft.port === engines[draft.engine].port || draft.port === ''
        ? engines[engine].port
        : draft.port,
    authSource: '',
    replicaSet: '',
    mongoSrv: false,
    // Keep an explicit security choice when switching the new connection's engine.
    tls: draft.tls,
  };
}

/** UI-only intent never enters the strict Host schema or credential store. */
export function connectionPayload(draft: Draft) {
  const { passwordMode, ...connection } = draft;
  return {
    ...connection,
    password: passwordMode === 'replace' ? draft.password : '',
    clearPassword: passwordMode === 'clear',
  };
}

export function changePasswordMode(draft: Draft, passwordMode: Draft['passwordMode']): Draft {
  return { ...draft, passwordMode, password: '', clearPassword: passwordMode === 'clear' };
}

export function securityLabel(tls: boolean): string {
  return tls ? 'TLS · 验证证书与主机名' : '不要求加密';
}
