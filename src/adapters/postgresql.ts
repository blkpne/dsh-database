import { stage, cancellation, driverClosed } from '../observability.js';
import pg from 'pg';
import { checkServerIdentity, type PeerCertificate } from 'node:tls';
import type { Adapter } from './types.js';
import { abortable, networkHost, sqlStatement } from './types.js';

export const execute: Adapter = async (input, { config, password, signal, result }) => {
  const identity = config.host.replace(/^\[|\]$/g, '');
  const options = {
    host: networkHost(config.host),
    port: config.port,
    user: config.user,
    // A callback keeps pg from falling back to PGPASSWORD/.pgpass on an empty password.
    password: async () => password,
    database: config.database,
    // pg omits servername for IPs; verify the configured identity explicitly instead of
    // Node's socket/localhost fallback. This callback runs before database authentication.
    ssl: config.tls
      ? {
          rejectUnauthorized: true,
          checkServerIdentity: (_host: string, cert: PeerCertificate) =>
            checkServerIdentity(identity, cert),
        }
      : false,
    connectionTimeoutMillis: Math.min(config.timeoutMs, 10000),
    statement_timeout: config.timeoutMs,
    idle_in_transaction_session_timeout: config.timeoutMs,
    application_name: 'dsh-database',
    options: '',
  };
  const client = new pg.Client(options);
  client.on('error', () => {});
  let pid: number | undefined;
  let stopping: Promise<void> | undefined;
  let ending: Promise<void> | undefined;
  const end = () =>
    (ending ??= client.end().then(
      () => driverClosed(),
      () => stage('cleanup-failed'),
    ));
  // Each execution owns this entire session. Terminate it rather than canceling only the
  // current statement: cancellation arriving between protocol messages can be discarded,
  // allowing an already-buffered Execute to start after the caller has canceled.
  const stop = () =>
    (stopping ??= (async () => {
      if (pid !== undefined) {
        const control = new pg.Client({
          ...options,
          connectionTimeoutMillis: 1000,
          statement_timeout: 1000,
          query_timeout: 1000,
        });
        control.on('error', () => {});
        try {
          await control.connect();
          await control.query('SELECT pg_terminate_backend($1)', [pid]);
        } catch {
          /* The original server statement_timeout remains the fallback. */
        } finally {
          await control.end().catch(() => {});
        }
      }
      await end();
    })());
  try {
    await abortable(client.connect(), signal, () => {
      void stop();
    });
    const identity = await abortable(client.query('SELECT pg_backend_pid() AS pid'), signal, () => {
      void stop();
    });
    pid = identity.rows[0].pid;
    stage('readonly-setup');
    await abortable(client.query('BEGIN READ ONLY'), signal, () => {
      void stop();
    });
    await abortable(
      new Promise<void>((resolve, reject) => {
        let fields = false;
        stage('execute');
        const queryOptions = {
          ...sqlStatement(input),
          rowMode: 'array' as const,
          queryMode: 'extended',
          types: {
            getTypeParser: (oid: number) =>
              // Array parsers otherwise turn numeric into Number and timestamps into Date
              // before the result collector can preserve precision. Keep their wire text,
              // including dimensions, NULLs and escaping, just like JSON/JSONB scalars.
              [
                20, 1700, 1082, 1114, 1184, 114, 3802, 1016, 1231, 1182, 1115, 1185, 199, 3807,
              ].includes(oid)
                ? (value: string) => value
                : pg.types.getTypeParser(oid),
          },
        };
        const query = new pg.Query(queryOptions);
        query.on('row', (row: unknown[], metadata) => {
          if (!fields) {
            result.fields(metadata!.fields.map((f) => f.name));
            fields = true;
          }
          if (!result.row(row)) {
            void stop().then(resolve, reject);
          }
        });
        query.on('error', (error) => {
          if (['57014', '57P01'].includes((error as { code?: string }).code ?? ''))
            cancellation(true);
          if (result.truncated) resolve();
          else reject(error);
        });
        query.on('end', (metadata) => {
          if (!fields) result.fields(metadata.fields.map((f) => f.name));
          resolve();
        });
        client.query(query);
      }),
      signal,
      () => {
        void stop();
      },
    );
  } finally {
    if (stopping) await stopping;
    await end();
  }
};
