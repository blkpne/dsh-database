import { z } from 'zod';

export class DatabaseError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DatabaseError';
  }
}

/** Never forward driver messages: they may include queries, values, credentials or hosts. */
export function safeError(error: unknown): { code: string; message: string } {
  if (error instanceof DatabaseError) return { code: error.code, message: error.message };
  if (error instanceof z.ZodError) {
    // Only our public field names, never values, unknown keys or nested database field names.
    const fields = new Set([
      'action',
      'name',
      'schema',
      'catalog',
      'type',
      'limit',
      'offset',
      'refresh',
      'sql',
      'operation',
      'collection',
      'filter',
      'projection',
      'sort',
      'pipeline',
      'engine',
      'host',
      'port',
      'user',
      'database',
      'password',
      'clearPassword',
      'authSource',
      'replicaSet',
      'mongoSrv',
      'tls',
      'maxRows',
      'timeoutMs',
      'policy',
      'id',
      'revision',
      'enabled',
    ]);
    const hints = [
      ...new Set(
        error.issues.slice(0, 5).map((issue) => {
          const field = String(issue.path[0] ?? '');
          if (!fields.has(field)) return '参数';
          const bounds: Record<string, string> = {
            limit: '请检查当前操作允许的数量范围',
            offset: '需为 0–100000 的整数',
            port: '需为 1–65535 的整数',
            maxRows: '需为 1–5000 的整数',
            timeoutMs: '需为 100–60000 的整数',
            name: '请填写有效名称；describe 需要精确对象名',
          };
          return `${field}：${bounds[field] ?? '缺失或格式不符合契约'}`;
        }),
      ),
    ];
    return {
      code: 'INVALID_INPUT',
      message: `输入无效（${hints.join('；')}）。请检查工具或表单字段要求。`,
    };
  }
  const raw = error as { code?: string | number; errorNum?: number; number?: number } | null;
  const code = String(
    raw?.code ??
      (raw?.errorNum ? `ORA-${String(raw.errorNum).padStart(5, '0')}` : (raw?.number ?? '')),
  );
  const messages: Record<string, string> = {
    POLICY_DENIED: '当前会话或操作未获授权，请检查连接的访问约束。',
    RATE_LIMITED: '调用额度已用完，请等待下一个分钟或小时窗口。',
    BUSY: '连接并发已满，请等待现有调用清理结束后重试。',
    CONNECTION_DISABLED: '连接已停用，请检查 Agent 访问开关。',
    MISSING_PASSWORD: '保存的凭据不可用，请在连接设置中重新填写密码。',
    TIMEOUT: '操作超时，请检查连接并缩小查询或结构搜索范围。',
    CANCELED: '调用已取消，可根据需要重新发起。',
    INVALID_INPUT: '工具参数无效，请按工具输入格式重试。',
    READ_ONLY_VIOLATION: '语句超出只读边界，请改用受支持的只读操作。',
    METADATA_DENIED: '数据库可连接，但账户缺少结构发现权限。',
    HOST_REJECTED: '宿主拒绝了此调用，请检查宿主权限及工具设置。',
    ER_ACCESS_DENIED_ERROR: '数据库拒绝登录，请检查用户名、密码及账户的主机授权。',
    ER_BAD_DB_ERROR: '数据库不存在，请检查数据库名称，或留空后查询 SHOW DATABASES。',
    ECONNREFUSED: '无法连接数据库，请检查地址、端口和服务状态。',
    ENOTFOUND: '数据库主机名无法解析。',
    ETIMEDOUT: '数据库连接超时，请检查网络或降低查询开销。',
    ER_PARSE_ERROR: 'SQL 语法错误，请按 MySQL 方言检查语句。',
    ER_NO_SUCH_TABLE: '表不存在，请先执行 SHOW TABLES 或检查数据库名称。',
    ER_BAD_FIELD_ERROR: '列不存在，请先执行 DESCRIBE 检查列名。',
    ER_NO_DB_ERROR: '未选择数据库，请编辑连接设置数据库名，或使用 database.table。',
    ER_TABLEACCESS_DENIED_ERROR: '数据库账户没有访问该表的权限。',
    ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION: '此语句不允许在只读事务中执行。',
    HANDSHAKE_SSL_ERROR: 'TLS 握手失败，请检查服务器证书与 TLS 配置。',
    SELF_SIGNED_CERT_IN_CHAIN: 'TLS 证书不受信任，请为 Node 配置受信任的 CA。',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS 证书不受信任，请为 Node 配置受信任的 CA。',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS 证书链不完整或不受信任，请检查服务器证书链与 CA。',
    ERR_TLS_CERT_ALTNAME_INVALID: 'TLS 证书与主机地址不匹配，请检查证书中的域名或 IP。',
    CERT_HAS_EXPIRED: 'TLS 证书已过期，请更新服务器证书。',
    '28P01': '数据库拒绝登录，请检查用户名和密码。',
    '3D000': '数据库不存在，请检查数据库名称。',
    '42501': '数据库账户权限不足。',
    '42601': 'SQL 语法错误，请使用当前数据库的 SQL 方言。',
    '42P01': '表不存在，请检查数据库、schema 和表名。',
    '25006': '此语句不允许在只读事务中执行。',
    '57014': '查询已取消或达到数据库超时限制。',
    ELOGIN: '数据库拒绝登录，请检查账户及 SQL Server 身份验证设置。',
    ESOCKET: '数据库连接失败，请检查网络、端口及 TLS 证书。',
    ETIMEOUT: '数据库操作超时，请检查网络或缩小查询范围。',
    ECANCEL: '查询已取消。',
    'ORA-01017': '数据库拒绝登录，请检查用户名和密码。',
    'ORA-01031': '数据库账户权限不足。',
    'ORA-00942': '表或视图不存在，请检查 owner 和访问权限。',
    'ORA-01456': '此语句不允许在只读事务中执行。',
    'ORA-01013': '数据库操作已取消。',
    'NJS-123': 'Oracle 操作达到驱动超时限制，请缩小查询范围。',
    'NJS-138': '此 Oracle 服务端版本不支持 Thin 驱动，请使用 Oracle 12.1 或更新版本。',
    '18': 'MongoDB 认证失败，请检查用户名、密码和认证数据库。',
    '13': 'MongoDB 账户没有读取该数据库的权限。',
    '50': 'MongoDB 操作达到服务器时间限制，请缩小查询范围。',
  };
  if (code && Object.hasOwn(messages, code)) return { code, message: messages[code]! };
  return {
    code: /^(ORA-\d{5}|NJS-\d{3}|DPI-\d{4}|[0-9A-Z]{5}|ER_[A-Z_]{1,64})$/.test(code)
      ? code
      : 'DATABASE_ERROR',
    message: '数据库操作失败，请检查连接、查询语法和账户权限。',
  };
}
