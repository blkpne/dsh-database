import { stage, cancellation, driverClosed } from '../observability.js';
import tedious from 'tedious';
import type { Request } from 'tedious';
import type { Adapter } from './types.js';
import { abortable, networkHost, sqlStatement } from './types.js';
import { DatabaseError } from '../schema.js';

export const execute: Adapter = async (input, { config, password, signal, result }) => {
  const connection = new tedious.Connection({
    server: networkHost(config.host, config.tls),
    authentication: { type: 'default', options: { userName: config.user, password } },
    options: {
      port: config.port,
      database: config.database || 'master',
      encrypt: config.tls,
      trustServerCertificate: false,
      connectTimeout: Math.min(config.timeoutMs, 10000),
      requestTimeout: config.timeoutMs,
      cancelTimeout: 1000,
      maxRetriesOnTransientErrors: 0,
      readOnlyIntent: true,
      rowCollectionOnRequestCompletion: false,
      rowCollectionOnDone: false,
      useColumnNames: false,
    },
  });
  connection.on('error', () => {});
  const closed = new Promise<void>((resolve) => connection.once('end', resolve));
  let request: Request | undefined;
  let connecting: Promise<void> | undefined;
  const cancel = () => {
    cancellation();
    if (request) request.cancel();
    else connection.close();
  };
  try {
    connecting = new Promise<void>((resolve, reject) =>
      connection.connect((error) => (error ? reject(error) : resolve())),
    );
    await abortable(connecting, signal, cancel);
    // readOnlyIntent is routing only. The SQL policy and database read-only account enforce access.
    await abortable(
      new Promise<void>((resolve, reject) => {
        let failure: unknown;
        stage('execute');
        const statement = sqlStatement(input);
        request = new tedious.Request(statement.text, (error) => {
          if (failure) reject(failure);
          else if (error && !result.truncated) reject(error);
          else resolve();
        });
        request.on('columnMetadata', (columns) => {
          if (Array.isArray(columns)) result.fields(columns.map((column) => column.colName));
        });
        request.on('row', (columns: { value: unknown; metadata: { type: { name: string } } }[]) => {
          if (failure || result.truncated) return;
          // Tedious parses these types through JS numbers. Require an explicit text cast to avoid
          // silently rounding financial/high-precision values before they reach our serializer.
          if (
            columns.some(
              (column) =>
                /^(Numeric|Decimal|Money|SmallMoney)/.test(column.metadata.type.name) &&
                column.value !== null,
            )
          ) {
            failure = new DatabaseError(
              'UNSUPPORTED_TYPE',
              'SQL Server 精确小数或金额列请用 CAST(column AS varchar(100)) 返回，避免驱动丢失精度。',
            );
            request!.cancel();
            return;
          }
          if (!result.row(columns.map((column) => column.value))) request!.cancel();
        });
        statement.values.forEach((value, i) =>
          request!.addParameter(`p${i + 1}`, tedious.TYPES.NVarChar, value),
        );
        connection.execSql(request);
      }),
      signal,
      cancel,
    );
  } finally {
    // Tedious may attach its socket after an early close during connect. Wait for that
    // bounded handshake to settle, then close again before relinquishing ownership.
    await connecting?.catch(() => {});
    connection.close();
    await closed;
    driverClosed();
  }
};
