import { stage, cancellation, driverClosed } from '../observability.js';
import mysql from 'mysql2';
import { connect, isIP } from 'node:net';
import type { FieldPacket } from 'mysql2';
import type { Adapter } from './types.js';
import { abortable, networkHost, sqlStatement } from './types.js';
import { DatabaseError } from '../schema.js';

export const execute: Adapter = async (input, { config, password, signal, result }) => {
  const host = config.tls ? config.host.replace(/^\[|\]$/g, '') : networkHost(config.host);
  const options: mysql.ConnectionOptions = {
    host,
    port: config.port,
    user: config.user,
    password,
    database: config.database || undefined,
    ssl: config.tls ? { rejectUnauthorized: true, verifyIdentity: true } : undefined,
    // mysql2 3.24.4 omits both TLS host and SNI for IP literals. Node then falls back to
    // socket._host (otherwise "localhost"). Keep the actual IP for certificate checking,
    // without sending an IP as SNI. This narrow Node 22/24 compatibility shim is covered
    // by real TLS tests; never verify identity after sending database credentials.
    ...(config.tls && isIP(host)
      ? {
          stream: () => {
            const socket = connect({ host, port: config.port }) as ReturnType<typeof connect> & {
              _host: string;
            };
            socket._host = host;
            return socket;
          },
        }
      : {}),
    connectTimeout: Math.min(config.timeoutMs, 10000),
    multipleStatements: false,
    rowsAsArray: true,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    charset: 'utf8mb4',
    flags: ['-LOCAL_FILES'],
  };
  const connection = mysql.createConnection(options);
  connection.on('error', () => {});
  let stopping: Promise<void> | undefined;
  // Closing a client socket alone does not stop a running server query (for example SLEEP).
  // Keep the original session alive until its own account has attempted KILL QUERY, so its
  // server-assigned ID cannot be reused for another session while cancellation is in flight.
  const stop = () =>
    (stopping ??= (async () => {
      const id = connection.threadId;
      let control: mysql.Connection | undefined;
      try {
        if (Number.isSafeInteger(id) && id! > 0) {
          control = mysql.createConnection({ ...options, connectTimeout: 1000 });
          control.on('error', () => {});
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 1000);
            try {
              control!.query(`KILL QUERY ${id}`, (error) => {
                clearTimeout(timer);
                resolve();
              });
            } catch {
              clearTimeout(timer);
              resolve();
            }
          });
        }
      } catch {
        // A proxy/server may deny cancellation or be unreachable. Client cleanup is still owned.
      } finally {
        control?.destroy();
        connection.destroy();
      }
    })());
  const cancel = () => {
    cancellation();
    void stop();
  };
  try {
    const run = (sql: string) =>
      abortable(
        new Promise<void>((resolve, reject) =>
          connection.query(sql, (error) => (error ? reject(error) : resolve())),
        ),
        signal,
        cancel,
      );
    await abortable(
      new Promise<void>((resolve, reject) =>
        connection.connect((error) => (error ? reject(error) : resolve())),
      ),
      signal,
      cancel,
    );
    stage('readonly-setup');
    await run('SET SESSION TRANSACTION READ ONLY');
    await run('START TRANSACTION READ ONLY');
    await abortable(
      new Promise<void>((resolve, reject) => {
        let finished = false;
        const finish = (truncated = false) => {
          if (!finished) {
            finished = true;
            if (truncated || stopping) void (stopping ?? stop()).then(resolve, reject);
            else {
              connection.destroy();
              resolve();
            }
          }
        };
        stage('execute');
        const statement = sqlStatement(input);
        // Prepared values avoid SQL-mode-dependent string escaping in catalog filters.
        const command = statement.values.length
          ? connection.execute(statement.text, statement.values)
          : connection.query(statement.text);
        command.on('fields', (fields: FieldPacket[]) => result.fields(fields.map((f) => f.name)));
        command.on('result', (row: unknown) => {
          if (finished) return;
          if (!Array.isArray(row)) {
            finished = true;
            reject(new DatabaseError('READ_ONLY_VIOLATION', '语句没有返回可读取的结果集。'));
          } else if (!result.row(row)) finish(true);
        });
        command.on('error', (error) => {
          if (error.code === 'ER_QUERY_INTERRUPTED') cancellation(true);
          if (!finished) reject(error);
        });
        command.on('end', () => finish());
      }),
      signal,
      cancel,
    );
  } finally {
    if (stopping) await stopping;
    connection.destroy();
    driverClosed();
  }
};
