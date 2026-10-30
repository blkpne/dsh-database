import mysql from 'mysql2/promise';
import pg from 'pg';
import tedious from 'tedious';
import oracledb from 'oracledb';
import { MongoClient, Decimal128, Long, ObjectId } from 'mongodb';
import { setTimeout as delay } from 'node:timers/promises';
import type { Instance } from './lifecycle.js';
import { QueryRunner } from '../../src/query.js';
import { connectionInput } from '../../src/schema.js';
import type { ConnectionFields } from '../../src/schema.js';
import { CommandFailure, docker, type DockerCommand } from './process.js';

export const table = (instance: Instance) =>
  instance.engine === 'oracle' ? 'SYSTEM.dsh_test_items' : 'dsh_test_items';
export function config(instance: Instance, admin = false): ConnectionFields {
  return connectionInput.parse({
    engine: instance.engine,
    name: `Docker ${instance.engine}`,
    host: '127.0.0.1',
    port: instance.port,
    user: admin
      ? {
          mysql: 'root',
          mariadb: 'root',
          postgresql: 'postgres',
          sqlserver: 'sa',
          oracle: 'system',
          mongodb: 'root',
        }[instance.engine]
      : 'dsh_reader',
    database: instance.engine === 'oracle' ? 'FREEPDB1' : 'dsh_test',
    authSource: instance.engine === 'mongodb' ? 'admin' : '',
    tls: false,
    maxRows: 2,
    timeoutMs: 10000,
  });
}

type SqlSession = { sql: (text: string) => Promise<unknown[][]> };
async function oracleConnection(instance: Instance, admin: boolean) {
  const settings = config(instance, admin);
  const client = await oracledb.getConnection({
    user: settings.user,
    password: admin ? instance.adminPassword : instance.password,
    connectString: `${settings.host}:${settings.port}/${settings.database}`,
    connectTimeout: 3,
    transportConnectTimeout: 3,
    retryCount: 0,
  });
  client.callTimeout = 10000;
  return client;
}

export async function withSql<T>(
  instance: Instance,
  admin: boolean,
  action: (session: SqlSession) => Promise<T>,
  database?: string,
): Promise<T> {
  const settings = config(instance, admin);
  const password = admin ? instance.adminPassword : instance.password;
  const common = {
    host: settings.host,
    port: settings.port,
    user: settings.user,
    password,
    database: database ?? settings.database,
  };
  if (instance.engine === 'mysql' || instance.engine === 'mariadb') {
    const client = await mysql.createConnection({
      ...common,
      connectTimeout: 3000,
      rowsAsArray: true,
    });
    try {
      return await action({ sql: async (text) => (await client.query(text))[0] as unknown[][] });
    } finally {
      await client.end();
    }
  }
  if (instance.engine === 'postgresql') {
    const client = new pg.Client({
      ...common,
      connectionTimeoutMillis: 3000,
      statement_timeout: 10000,
    });
    client.on('error', () => {});
    try {
      await client.connect();
      return await action({
        sql: async (text) => (await client.query({ text, rowMode: 'array' })).rows,
      });
    } finally {
      await client.end();
    }
  }
  if (instance.engine === 'oracle') {
    const client = await oracleConnection(instance, admin);
    try {
      return await action({
        sql: async (text) =>
          (await client.execute<unknown[]>(text, [], { autoCommit: true })).rows ?? [],
      });
    } finally {
      await client.close();
    }
  }
  if (instance.engine !== 'sqlserver') throw new Error('SQL fixture called for MongoDB');
  const client = new tedious.Connection({
    server: common.host,
    authentication: { type: 'default', options: { userName: common.user, password } },
    options: {
      port: common.port,
      database: common.database,
      encrypt: false,
      trustServerCertificate: false,
      connectTimeout: 3000,
      requestTimeout: 10000,
      maxRetriesOnTransientErrors: 0,
    },
  });
  client.on('error', () => {});
  const ended = new Promise<void>((resolve) => client.once('end', resolve));
  try {
    await new Promise<void>((resolve, reject) =>
      client.connect((error) => (error ? reject(error) : resolve())),
    );
    return await action({
      sql: (text) =>
        new Promise((resolve, reject) => {
          const rows: unknown[][] = [];
          const request = new tedious.Request(text, (error) =>
            error ? reject(error) : resolve(rows),
          );
          request.on('row', (columns: { value: unknown }[]) =>
            rows.push(columns.map((column) => column.value)),
          );
          client.execSql(request);
        }),
    });
  } finally {
    client.close();
    await ended;
  }
}

export async function withMongo<T>(
  instance: Instance,
  admin: boolean,
  action: (client: MongoClient) => Promise<T>,
): Promise<T> {
  const client = new MongoClient(`mongodb://127.0.0.1:${instance.port}`, {
    auth: {
      username: admin ? 'root' : 'dsh_reader',
      password: admin ? instance.adminPassword : instance.password,
    },
    authSource: 'admin',
    serverSelectionTimeoutMS: 3000,
    connectTimeoutMS: 3000,
    timeoutMS: 10000,
    maxPoolSize: 1,
  });
  try {
    await client.connect();
    return await action(client);
  } finally {
    await client.close();
  }
}

export async function waitReady(instance: Instance, run: DockerCommand = docker): Promise<void> {
  // SQL Server has no user database yet; Oracle initializes asynchronously for several minutes.
  const deadline = Date.now() + (instance.engine === 'oracle' ? 600000 : 180000);
  while (Date.now() < deadline) {
    instance.signal.throwIfAborted();
    const state = JSON.parse(
      await run(['inspect', '--format', '{{json .State}}', instance.name], {
        signal: instance.signal,
      }),
    );
    if (!state.Running || state.OOMKilled)
      throw new CommandFailure(
        state.OOMKilled ? 'DOCKER_OOM' : 'DOCKER_CONTAINER_EXITED',
        state.OOMKilled
          ? 'Database container exhausted its memory limit before readiness.'
          : `Database container stopped before readiness (exit code ${Number(state.ExitCode)}).`,
      );
    if (instance.engine === 'oracle') {
      // The prebuilt image opens its listener/PDB before applying ORACLE_PWD. Probing
      // credentials during that window can lock SYSTEM before initialization completes.
      const log = await run(['logs', '--tail', '200', instance.name], {
        signal: instance.signal,
      });
      if (!log.includes('DATABASE IS READY TO USE!')) {
        await delay(1000, undefined, { signal: instance.signal });
        continue;
      }
    }
    try {
      if (instance.engine === 'mongodb')
        await withMongo(instance, true, (client) => client.db('admin').command({ ping: 1 }));
      else
        await withSql(
          instance,
          true,
          (client) => client.sql(instance.engine === 'oracle' ? 'SELECT 1 FROM DUAL' : 'SELECT 1'),
          instance.engine === 'sqlserver' ? 'master' : undefined,
        );
      return;
    } catch {
      /* Expected during initialization; driver errors may contain credentials. */
    }
    await delay(1000, undefined, { signal: instance.signal });
  }
  throw new Error('Database did not become ready before startup deadline');
}

// Writes are confined to fresh, runner-owned containers; never used by test:engines/test:mysql.
export async function seed(instance: Instance): Promise<void> {
  if (instance.engine === 'mongodb') {
    await withMongo(instance, true, async (client) => {
      await client
        .db('dsh_test')
        .collection('dsh_test_items')
        .insertMany([
          {
            _id: new ObjectId('000000000000000000000001'),
            id: 1,
            category: 'A',
            amount: Decimal128.fromString('10.125'),
            huge: Long.fromString('9007199254740993'),
            note: '中文 fixture',
            at: new Date('2026-01-02T03:04:05Z'),
          },
          { id: 2, category: 'A', amount: Decimal128.fromString('20.250') },
          { id: 3, category: 'B', amount: Decimal128.fromString('5.000') },
        ]);
      await client.db('admin').command({
        createUser: 'dsh_reader',
        pwd: instance.password,
        roles: [{ role: 'read', db: 'dsh_test' }],
      });
    });
    return;
  }
  if (instance.engine === 'sqlserver')
    await withSql(instance, true, (client) => client.sql('CREATE DATABASE dsh_test'), 'master');
  await withSql(instance, true, async ({ sql }) => {
    await sql(
      `CREATE TABLE ${table(instance)} (id INTEGER PRIMARY KEY, category VARCHAR(30), amount DECIMAL(18,3), huge DECIMAL(20,0), note ${instance.engine === 'sqlserver' ? 'NVARCHAR' : 'VARCHAR'}(80))`,
    );
    for (const [id, category, amount] of [
      [1, 'A', '10.125'],
      [2, 'A', '20.250'],
      [3, 'B', '5.000'],
    ])
      await sql(
        `INSERT INTO ${table(instance)} VALUES (${id}, '${category}', ${amount}, 9007199254740993, ${instance.engine === 'sqlserver' ? 'N' : ''}'中文 fixture')`,
      );
    const password = instance.password; // Generated alphanumeric/underscore only; never user input.
    if (instance.engine === 'mysql' || instance.engine === 'mariadb') {
      await sql(`CREATE USER 'dsh_reader'@'%' IDENTIFIED BY '${password}'`);
      await sql("GRANT SELECT ON dsh_test.* TO 'dsh_reader'@'%'");
    } else if (instance.engine === 'postgresql') {
      await sql(`CREATE ROLE dsh_reader LOGIN PASSWORD '${password}'`);
      await sql('GRANT CONNECT ON DATABASE dsh_test TO dsh_reader');
      await sql('GRANT USAGE ON SCHEMA public TO dsh_reader');
      await sql('GRANT SELECT ON ALL TABLES IN SCHEMA public TO dsh_reader');
    } else if (instance.engine === 'sqlserver') {
      await sql(`CREATE LOGIN dsh_reader WITH PASSWORD='${password}', CHECK_POLICY=OFF`);
      await sql('CREATE USER dsh_reader FOR LOGIN dsh_reader');
      await sql('ALTER ROLE db_datareader ADD MEMBER dsh_reader');
      await sql('ALTER ROLE db_denydatawriter ADD MEMBER dsh_reader');
    } else {
      await sql(`CREATE USER dsh_reader IDENTIFIED BY "${password}"`);
      await sql('GRANT CREATE SESSION TO dsh_reader');
      await sql(`GRANT SELECT ON ${table(instance)} TO dsh_reader`);
    }
  });
  // A freshly created Oracle table can reject a READ ONLY snapshot with ORA-01466.
  // Retry only this fixture-initialization race, in new transactions, for at most 15s.
  // Production queries and the assertions below never retry or relax READ ONLY.
  if (instance.engine === 'oracle') {
    const deadline = Date.now() + 15000;
    for (;;) {
      instance.signal.throwIfAborted();
      const client = await oracleConnection(instance, false);
      let retry = false;
      try {
        await client.execute('SET TRANSACTION READ ONLY');
        const response = await client.execute<unknown[]>(
          `SELECT id, category, note FROM ${table(instance)} ORDER BY id`,
        );
        if (response.rows?.length !== 3) throw new Error('Oracle fixture is incomplete');
      } catch (error: any) {
        if (error.code !== 'ORA-01466' || Date.now() >= deadline) throw error;
        retry = true;
      } finally {
        await client.close();
      }
      if (!retry) break;
      await delay(1000, undefined, { signal: instance.signal });
    }
  }
  const runner = new QueryRunner(config(instance), async () => instance.password);
  try {
    await runner.test(instance.signal);
  } finally {
    await runner.close();
  }
}
