import { stage, cancellation, driverClosed } from '../observability.js';
import mysql from 'mysql2';
import { isIP } from 'node:net';
import { connect as connectTls } from 'node:tls';
import type { Duplex } from 'node:stream';
import { verifyServerIdentity } from './tls.js';
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
  const createConnection = (connectTimeout = options.connectTimeout) => {
    const connection = mysql.createConnection({ ...options, connectTimeout });
    if (config.tls && isIP(host)) {
      // mysql2 does not expose a TLS identity callback. Override only this
      // connection's upgrade hook, before its greeting can arrive. DNS keeps the
      // driver's normal path. No global TLS/driver state or session cache changes.
      const client = connection as mysql.Connection & {
        stream: Duplex;
        startTLS: (done: (error?: Error) => void) => void;
        packetParser: { execute: (data: Buffer) => void };
        _handleNetworkError: (error: Error) => void;
      };
      if (typeof client.startTLS !== 'function' || !client.packetParser) {
        connection.destroy();
        throw new Error('Unsupported MySQL TLS upgrade interface.');
      }
      client.startTLS = (done) => {
        client.stream.removeAllListeners('data');
        let established = false;
        let reported = false;
        const secure = connectTls(
          {
            socket: client.stream,
            rejectUnauthorized: true,
            checkServerIdentity: (_host, cert) => verifyServerIdentity(host, cert),
          },
          () => {
            established = true;
            reported = true;
            done();
          },
        );
        secure.on('error', (error) => {
          if (established) client._handleNetworkError(error);
          else if (!reported) {
            reported = true;
            done(error);
          }
        });
        secure.on('data', (data: Buffer) => client.packetParser.execute(data));
        client.stream = secure;
      };
    }
    return connection;
  };
  const connection = createConnection();
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
          control = createConnection(1000);
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
