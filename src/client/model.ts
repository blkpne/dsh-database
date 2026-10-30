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
  | 'name'
  | 'host'
  | 'user'
  | 'database'
  | 'tls'
  | 'engine'
  | 'authSource'
  | 'replicaSet'
  | 'mongoSrv'
> & {
  policy: AccessPolicy;
  port: number | '';
  maxRows: number | '';
  timeoutMs: number | '';
  password: string;
  clearPassword: boolean;
};

export type SaveResponse = { connectionId: string; connections: Connection[] };
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
    tls: true,
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
    tls: engine === 'sqlserver' ? true : draft.tls,
  };
}
