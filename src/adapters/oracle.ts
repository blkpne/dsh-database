import { stage, cancellation, driverClosed } from '../observability.js';
import oracledb from 'oracledb';
import type { Adapter } from './types.js';
import { abortable, networkHost, sqlStatement } from './types.js';
import { oracleConstraints } from './oracle-metadata.js';

export const execute: Adapter = async (input, { config, password, signal, result }) => {
  const host = networkHost(config.host, config.tls);
  // Thin mode requires no Oracle Client installation; no global driver settings are mutated.
  const connection = await oracledb.getConnection({
    user: config.user,
    password,
    connectString: `${config.tls ? 'tcps' : 'tcp'}://${host.includes(':') ? `[${host}]` : host}:${config.port}/${config.database}`,
    connectTimeout: Math.max(1, Math.ceil(Math.min(config.timeoutMs, 10000) / 1000)),
    transportConnectTimeout: Math.max(1, Math.ceil(Math.min(config.timeoutMs, 10000) / 1000)),
    retryCount: 0,
    sslServerDNMatch: true,
  });
  connection.callTimeout = config.timeoutMs;
  let breaking: Promise<void> | undefined;
  const cancel = () => {
    cancellation();
    breaking ??= connection.break().catch(() => {});
  };
  let resultSet: oracledb.ResultSet<unknown[]> | undefined;
  try {
    signal.throwIfAborted();
    stage('readonly-setup');
    await abortable(connection.execute('SET TRANSACTION READ ONLY'), signal, cancel);
    const read = async (
      statement: { text: string; values: string[] },
      accept: (row: unknown[]) => boolean,
      fields?: (columns: string[]) => void,
    ) => {
      signal.throwIfAborted();
      stage('execute');
      let pending: Promise<unknown> | undefined;
      try {
        const executing = connection
          .execute<unknown[]>(statement.text.replace(/;\s*$/, ''), statement.values, {
            resultSet: true,
            outFormat: oracledb.OUT_FORMAT_ARRAY,
            fetchArraySize: 32,
            prefetchRows: 32,
            fetchTypeHandler: (metadata) => {
              if (
                [oracledb.DB_TYPE_NUMBER, oracledb.DB_TYPE_CLOB, oracledb.DB_TYPE_NCLOB].some(
                  (type) => type === metadata.dbType,
                )
              )
                return { type: oracledb.DB_TYPE_VARCHAR };
              if (metadata.dbType === oracledb.DB_TYPE_BLOB) return { type: oracledb.DB_TYPE_RAW };
              return undefined;
            },
          })
          .then((response) => {
            resultSet = response.resultSet;
            return response;
          });
        pending = executing;
        const response = await abortable(executing, signal, cancel);
        fields?.((response.metaData ?? []).map((column) => column.name));
        if (!resultSet) throw new Error('missing result set');
        let complete = false;
        while (!complete) {
          const fetching = resultSet.getRows(32);
          pending = fetching;
          const rows = await abortable(fetching, signal, cancel);
          if (!rows.length) break;
          for (const row of rows)
            if (!accept(row)) {
              complete = true;
              break;
            }
        }
      } finally {
        // An abort can win immediately before execute produces its cursor. Keep
        // ownership until break and that pending driver operation both settle.
        if (breaking) await breaking;
        await pending?.catch(() => {});
        await resultSet?.close().catch(() => {});
        resultSet = undefined;
      }
    };
    if (typeof input !== 'string' && 'kind' in input && input.kind === 'metadata') {
      await oracleConstraints(input, read, result, signal);
    } else {
      await read(
        sqlStatement(input),
        (row) => result.row(row),
        (columns) => result.fields(columns),
      );
    }
  } finally {
    if (breaking) await breaking;
    await resultSet?.close().catch(() => {});
    await connection.close().then(
      () => driverClosed(),
      () => stage('cleanup-failed'),
    );
  }
};
