import { stage, cancellation, driverClosed } from '../observability.js';
import oracledb from 'oracledb';
import type { Adapter } from './types.js';
import { abortable, networkHost, sqlStatement } from './types.js';

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
    stage('execute');
    const statement = sqlStatement(input);
    const response = await abortable(
      connection.execute<unknown[]>(statement.text.replace(/;\s*$/, ''), statement.values, {
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
      }),
      signal,
      cancel,
    );
    resultSet = response.resultSet;
    result.fields((response.metaData ?? []).map((column) => column.name));
    if (!resultSet) throw new Error('missing result set');
    let complete = false;
    while (!complete) {
      const rows = await abortable(resultSet.getRows(32), signal, cancel);
      if (!rows.length) break;
      for (const row of rows)
        if (!result.row(row)) {
          complete = true;
          break;
        }
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
