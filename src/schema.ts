import { z } from 'zod';
import { engines } from './engines.js';
import { accessPolicy } from './policy.js';
import { jsonValue } from './json-schema.js';

export const connectionFields = z.object({
  policy: accessPolicy.optional(),
  engine: z
    .enum(['mysql', 'mariadb', 'postgresql', 'sqlserver', 'oracle', 'mongodb'])
    .default('mysql'),
  name: z.string().trim().min(1).max(80),
  host: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[a-zA-Z0-9.:[\]_-]+$/, '请输入主机名或 IP，不包含协议'),
  port: z.number().int().min(1).max(65535).optional(),
  user: z.string().trim().max(128).default(''),
  database: z.string().trim().max(128).default(''),
  authSource: z.string().trim().max(128).default(''),
  replicaSet: z
    .string()
    .trim()
    .max(128)
    .regex(/^[a-zA-Z0-9_.-]*$/)
    .default(''),
  mongoSrv: z.boolean().default(false),
  tls: z.boolean().default(true),
  maxRows: z.number().int().min(1).max(5000).default(500),
  timeoutMs: z.number().int().min(100).max(60000).default(15000),
});
export const connectionInput = connectionFields
  .extend({
    password: z.string().max(4096).optional(),
    clearPassword: z.boolean().default(false),
  })
  .strict()
  .superRefine(validateConnection)
  .superRefine((value, ctx) => {
    if (value.clearPassword && value.password)
      ctx.addIssue({
        code: 'custom',
        path: ['password'],
        message: '清空密码与填写新密码不能同时进行。',
      });
  })
  .transform(defaultPort);
export const connectionRecord = connectionFields
  .extend({
    id: z.string().regex(/^[a-f0-9]{16}$/),
    enabled: z.boolean(),
    revision: z.number().int().positive(),
    passwordRef: z
      .string()
      .regex(/^DSH_DATABASE_[A-F0-9_]+$/)
      .optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict()
  .superRefine(validateConnection)
  .transform(defaultPort);
export type ConnectionRecord = z.infer<typeof connectionRecord>;
export type ConnectionFields = Omit<z.infer<typeof connectionFields>, 'port'> & { port: number };
export type ConnectionInput = z.infer<typeof connectionInput>;
export const sqlInput = z.object({ sql: z.string().min(1).max(32768) }).strict();
export const truncationReason = z.enum([
  'row_limit',
  'byte_limit',
  'cell_limit',
  'unsupported_value',
]);
export const queryResult = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.array(jsonValue)).max(5000),
  rowCount: z.number().int().min(0).max(5000),
  truncated: z.boolean(),
  truncationReason: truncationReason.optional(),
  durationMs: z.number().min(0),
  readOnly: z.literal(true),
});
export type QueryResult = z.infer<typeof queryResult>;

function defaultPort<T extends z.infer<typeof connectionFields>>(value: T): T & { port: number } {
  return { ...value, port: value.port ?? engines[value.engine].port };
}

function validateConnection(value: z.infer<typeof connectionFields>, ctx: z.RefinementCtx) {
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: 'custom', path: [path], message });
  if (value.engine !== 'mongodb' && !value.user) issue('user', '请填写用户名。');
  if (engines[value.engine].databaseRequired && !value.database)
    issue('database', '请填写数据库名称或 Oracle 服务名。');
  if (value.engine === 'oracle' && !/^[a-zA-Z0-9_.-]+$/.test(value.database))
    issue('database', 'Oracle 服务名只接受字母、数字、下划线、点和连字符。');
  if (value.engine === 'mongodb') {
    if (/[\/\\. "$\0]/.test(value.database) || /[\/\\. "$\0]/.test(value.authSource))
      issue('database', 'MongoDB 数据库名或认证库名无效。');
    if (
      value.mongoSrv &&
      (!value.tls ||
        !/^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/.test(value.host) ||
        (value.port !== undefined && value.port !== 27017))
    )
      issue('mongoSrv', 'SRV 需要域名、TLS 和默认端口。');
  } else if (value.authSource || value.replicaSet || value.mongoSrv)
    issue('engine', 'MongoDB 专用设置不能用于其他数据库。');
}

export { DatabaseError, safeError } from './errors.js';
