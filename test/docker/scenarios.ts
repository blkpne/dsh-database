import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { QueryRunner } from '../../src/query.js';
import { connectDatabaseMcp } from '../../src/mcp.js';
import { queryResult, DatabaseError } from '../../src/schema.js';
import { harness } from '../harness.js';
import { config, table, withSql, withMongo } from './fixtures.js';
import type { Instance } from './lifecycle.js';
import { exerciseMongoCancellation } from './mongo-cancellation.js';

export async function exercise(instance: Instance): Promise<void> {
  const { engine, password, signal } = instance;
  const settings = config(instance);
  const mongo = engine === 'mongodb';
  const selectedTable = table(instance);
  const base = mongo
    ? { operation: 'find', collection: 'dsh_test_items', sort: { id: 1 } }
    : { sql: `SELECT id, category, note FROM ${selectedTable} ORDER BY id` };
  const runner = new QueryRunner(settings, async () => password);
  const step = (name: string) => {
    signal.throwIfAborted();
    console.log(`  ${engine}: ${name}`);
  };
  const read = () => (mongo ? runner.mongo(base, signal) : runner.query(base.sql!, signal));
  try {
    step('server version and real connection');
    const version = mongo
      ? await withMongo(
          instance,
          true,
          async (client) => (await client.db('admin').command({ buildInfo: 1 })).version,
        )
      : await withSql(
          instance,
          true,
          async ({ sql }) =>
            (
              await sql(
                {
                  mysql: 'SELECT VERSION()',
                  mariadb: 'SELECT VERSION()',
                  postgresql: 'SELECT version()',
                  sqlserver: "SELECT CAST(SERVERPROPERTY('ProductVersion') AS varchar(100))",
                  oracle: 'SELECT banner_full FROM v$version',
                  mongodb: '',
                }[engine],
              )
            )[0]?.[0],
        );
    console.log(
      `  Server: ${String(version)
        .replace(/[\r\n]/g, ' ')
        .slice(0, 220)}`,
    );
    assert.equal((await runner.test(signal)).readOnly, true);

    step('fixture reads, row cap, empty metadata, exact numeric values and aggregation');
    const capped = await read();
    assert.equal(capped.rowCount, 2);
    assert.equal(capped.truncated, true);
    if (mongo) {
      const document = capped.rows[0]![0] as Record<string, unknown>;
      assert.deepEqual(document._id, { $oid: '000000000000000000000001' });
      assert.deepEqual(document.huge, { $numberLong: '9007199254740993' });
      assert.deepEqual(document.amount, { $numberDecimal: '10.125' });
      assert.deepEqual(document.at, { $date: { $numberLong: '1767323045000' } });
      assert.equal(document.note, '中文 fixture');
      const count = await runner.mongo(
        { operation: 'count', collection: 'dsh_test_items', filter: { category: 'A' } },
        signal,
      );
      assert.equal(count.rows[0]![0], 2);
      const aggregate = await runner.mongo(
        {
          operation: 'aggregate',
          collection: 'dsh_test_items',
          pipeline: [
            { $match: { category: 'A' } },
            { $group: { _id: '$category', total: { $sum: '$amount' } } },
          ],
        },
        signal,
      );
      assert.deepEqual((aggregate.rows[0]![0] as any).total, { $numberDecimal: '30.375' });
    } else {
      assert.deepEqual(
        capped.columns.map((column) => column.toLowerCase()),
        ['id', 'category', 'note'],
      );
      assert.equal(Number(capped.rows[0]![0]), 1);
      assert.equal(capped.rows[0]![2], '中文 fixture');
      const empty = await runner.query(
        `SELECT id, category FROM ${selectedTable} WHERE id=99`,
        signal,
      );
      assert.equal(empty.rowCount, 0);
      assert.deepEqual(
        empty.columns.map((column) => column.toLowerCase()),
        ['id', 'category'],
      );
      const precision = await runner.query(
        `SELECT ${engine === 'sqlserver' ? 'CAST(huge AS varchar(100)), CAST(amount AS varchar(100))' : 'huge, amount'} FROM ${selectedTable} WHERE id=1`,
        signal,
      );
      assert.equal(precision.rows[0]![0], '9007199254740993');
      assert.equal(precision.rows[0]![1], '10.125');
      if (engine === 'postgresql') {
        const arrays = await runner.query(
          `SELECT
          array_agg(9007199254740993.123456789::numeric),
          array_agg(TIMESTAMP '2026-10-18 01:02:03.123456'),
          array_agg('{"amount":9007199254740993}'::jsonb)`,
          signal,
        );
        assert.deepEqual(arrays.rows[0], [
          '{9007199254740993.123456789}',
          '{"2026-10-18 01:02:03.123456"}',
          '{"{\\"amount\\": 9007199254740993}"}',
        ]);
        assert.equal(arrays.truncated, false);
      }
      if (engine === 'sqlserver') {
        for (const sql of [
          'SELECT 1\nSELECT 2',
          'SELECT 1\nCHECKPOINT',
          'SELECT 1--\rCHECKPOINT',
          'SELECT 1 FETCH NEXT FROM orders_cursor',
          `SELECT * FROM ${selectedTable} WITH (TABLOCKX, HOLDLOCK)`,
          `SELECT * FROM ${selectedTable} (XLOCK)`,
        ])
          await assert.rejects(runner.query(sql, signal), { code: 'READ_ONLY_VIOLATION' });
        // The server treats CR as the end of a comment; bypassing the plugin guard
        // reaches CHECKPOINT permission checking on this isolated read-only account.
        await withSql(instance, false, async ({ sql }) => {
          await assert.rejects(sql('SELECT 1--\rCHECKPOINT'), /permission/i);
          await assert.rejects(sql(`SELECT * FROM ${selectedTable} ('XLOCK')`), { number: 215 });
          for (const hint of ['[XLOCK ]', '"XLOCK "']) {
            const statement = `SELECT * FROM ${selectedTable} (${hint})`;
            await assert.rejects(runner.query(statement, signal), { code: 'READ_ONLY_VIOLATION' });
            // Quoted hint identifiers with trailing spaces are valid T-SQL lock hints.
            await sql(statement);
          }
        });
        const nested = await runner.query(
          `WITH x AS (SELECT id FROM ${selectedTable}) SELECT TOP (1) id FROM x ORDER BY id`,
          signal,
        );
        assert.equal(Number(nested.rows[0]![0]), 1);
        const page = await runner.query(
          `SELECT id FROM ${selectedTable} ORDER BY id OFFSET 1 ROWS FETCH NEXT 1 ROW ONLY`,
          signal,
        );
        assert.deepEqual(page.rows, [[2]]);
        assert.equal(page.truncated, false);
      }
      const aggregate = await runner.query(
        `SELECT ${engine === 'sqlserver' ? 'CAST(SUM(amount) AS varchar(100))' : 'SUM(amount)'}, COUNT(*) FROM ${selectedTable} WHERE category='A'`,
        signal,
      );
      assert.equal(Number(aggregate.rows[0]![0]), 30.375);
      assert.equal(Number(aggregate.rows[0]![1]), 2);
      if (engine === 'sqlserver')
        await assert.rejects(runner.query(`SELECT amount FROM ${selectedTable}`, signal), {
          code: 'UNSUPPORTED_TYPE',
        });
    }
    const exact = new QueryRunner({ ...settings, maxRows: 3 }, async () => password);
    try {
      const result = mongo ? await exact.mongo(base, signal) : await exact.query(base.sql!, signal);
      assert.equal(result.rowCount, 3);
      assert.equal(result.truncated, false);
    } finally {
      await exact.close();
    }

    step('v0.3 metadata discovery, describe, scoped cache and metadata-only enforcement');
    const inspector = new QueryRunner({ ...settings, maxRows: 100 }, async () => password);
    try {
      const capabilities = await inspector.inspect({ action: 'capabilities' }, signal);
      assert.deepEqual(capabilities.capabilities?.operations, ['inspect', 'query']);
      step('namespace discovery: visible and nonexistent names');
      const namespaces = await inspector.inspect(
        {
          action: 'namespaces',
          name:
            engine === 'oracle'
              ? 'SYSTEM'
              : engine === 'postgresql'
                ? 'public'
                : engine === 'sqlserver'
                  ? 'dbo'
                  : 'dsh_test',
          limit: 1,
        },
        signal,
      );
      assert.equal(namespaces.sections.namespaces?.status, 'available');
      assert.equal(namespaces.sections.namespaces?.rows.length, 1);
      const noNamespaces = await inspector.inspect(
        { action: 'namespaces', name: 'dsh_no_such_namespace_92874' },
        signal,
      );
      assert.equal(noNamespaces.sections.namespaces?.status, 'empty');
      step('object search, caller-isolated cache and exact description');
      const schema = engine === 'oracle' ? 'SYSTEM' : undefined;
      const objectName = engine === 'oracle' ? 'DSH_TEST_ITEMS' : 'dsh_test_items';
      const input = { action: 'search', name: objectName, schema, limit: 1 };
      const found = await inspector.inspect(input, signal, 'owner-a');
      assert.equal(found.sections.objects?.status, 'available');
      assert.equal(found.sections.objects?.rows.length, 1);
      assert.equal((await inspector.inspect(input, signal, 'owner-a')).cache.hit, true);
      assert.equal((await inspector.inspect(input, signal, 'owner-b')).cache.hit, false);
      const described = await inspector.inspect(
        { action: 'describe', name: objectName, schema },
        signal,
      );
      assert.equal(described.sections[mongo ? 'collection' : 'columns']?.status, 'available');
      assert.equal(described.sections.indexes?.status, 'available');
      assert(!JSON.stringify(described).includes('中文 fixture'));
      const hostile = await inspector.inspect({ action: 'search', name: "x' OR '1'='1" }, signal);
      assert.equal(hostile.sections.objects?.status, 'empty');
      if (mongo) {
        assert(described.sections.collection?.note?.includes('unknown'));
        await withMongo(instance, true, async (client) => {
          const db = client.db('dsh_test');
          await db.createCollection('dsh_metadata_typed', {
            validator: {
              $jsonSchema: {
                bsonType: 'object',
                properties: { identifier: { bsonType: 'string' } },
              },
            },
          });
          try {
            const typed = await inspector.inspect(
              { action: 'describe', name: 'dsh_metadata_typed' },
              signal,
            );
            assert(JSON.stringify(typed).includes('identifier'));
            assert.equal(typed.sections.collection?.note, undefined);
          } finally {
            await db.collection('dsh_metadata_typed').drop();
          }
        });
      } else {
        step('native keys, indexes and comments');
        // Temporary metadata-only fixtures are removed before any model benchmark runs.
        const prefix = engine === 'oracle' ? 'SYSTEM.' : '';
        await withSql(instance, true, async ({ sql }) => {
          await sql(`CREATE TABLE ${prefix}dsh_metadata_parent (id INTEGER PRIMARY KEY)`);
          try {
            await sql(
              `CREATE TABLE ${prefix}dsh_metadata_child (id INTEGER PRIMARY KEY, parent_id INTEGER, CONSTRAINT dsh_metadata_fk FOREIGN KEY (parent_id) REFERENCES ${prefix}dsh_metadata_parent(id))`,
            );
            try {
              if (engine === 'postgresql' || engine === 'oracle') {
                await sql(`GRANT SELECT ON ${prefix}dsh_metadata_parent TO dsh_reader`);
                await sql(`GRANT SELECT ON ${prefix}dsh_metadata_child TO dsh_reader`);
                await sql(
                  `COMMENT ON TABLE ${prefix}dsh_metadata_child IS 'connector native comment'`,
                );
              } else if (engine === 'sqlserver') {
                await sql(
                  "EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'connector native comment', @level0type=N'SCHEMA', @level0name=N'dbo', @level1type=N'TABLE', @level1name=N'dsh_metadata_child'",
                );
              } else
                await sql("ALTER TABLE dsh_metadata_child COMMENT = 'connector native comment'");
              const child = await inspector.inspect(
                {
                  action: 'describe',
                  name: engine === 'oracle' ? 'DSH_METADATA_CHILD' : 'dsh_metadata_child',
                  schema,
                },
                signal,
              );
              const text = JSON.stringify(child).toLowerCase();
              assert(text.includes('dsh_metadata_fk'));
              assert(text.includes('dsh_metadata_parent'));
              assert(text.includes('connector native comment'));
              assert(child.sections.columns?.rows.length === 2);
            } finally {
              await sql(`DROP TABLE ${prefix}dsh_metadata_child`);
            }
          } finally {
            await sql(`DROP TABLE ${prefix}dsh_metadata_parent`);
          }
        });
      }
      if (engine === 'postgresql') {
        await withSql(instance, true, async ({ sql }) => {
          await sql('CREATE SCHEMA catalog_other');
          try {
            await sql('CREATE TABLE catalog_other.dsh_test_items (shadow_id integer PRIMARY KEY)');
            await sql('GRANT USAGE ON SCHEMA catalog_other TO dsh_reader');
            await sql('GRANT SELECT ON catalog_other.dsh_test_items TO dsh_reader');
            const other = await inspector.inspect(
              { action: 'search', name: 'dsh_test_items', schema: 'catalog_other' },
              signal,
            );
            assert.equal(other.sections.objects?.rows.length, 1);
            const detail = await inspector.inspect(
              { action: 'describe', name: 'dsh_test_items', schema: 'catalog_other' },
              signal,
            );
            assert.equal(detail.sections.columns?.rows.length, 1);
            assert.equal(detail.sections.columns?.rows[0]?.[0], 'shadow_id');
            assert.equal(described.sections.columns?.rows.length, 5);
          } finally {
            await sql('DROP SCHEMA catalog_other CASCADE');
          }
        });
        await withSql(instance, true, async ({ sql }) => {
          await sql('BEGIN');
          for (let i = 0; i < 500; i++)
            await sql(
              `CREATE TABLE public.catalog_fixture_${String(i).padStart(3, '0')} (id integer PRIMARY KEY, note text)`,
            );
          await sql('GRANT SELECT ON ALL TABLES IN SCHEMA public TO dsh_reader');
          await sql('COMMIT');
        });
        const located = await inspector.inspect(
          { action: 'search', name: 'catalog_fixture_417' },
          signal,
        );
        assert.equal(located.sections.objects?.rows.length, 1);
        const details = await inspector.inspect(
          { action: 'describe', name: 'catalog_fixture_417' },
          signal,
        );
        assert.equal(details.sections.columns?.rows.length, 2);
        const page = await inspector.inspect(
          { action: 'search', name: 'catalog_fixture_', limit: 30 },
          signal,
        );
        assert.equal(page.sections.objects?.rows.length, 30);
        assert.equal(page.nextOffset, 30);
        console.log(
          `  500-table fixture: targeted search + describe = 2 calls; ${Buffer.byteLength(JSON.stringify([located, details]))} output bytes`,
        );
      }
    } finally {
      await inspector.close();
    }
    const metadataOnly = new QueryRunner(
      {
        ...settings,
        policy: {
          mode: 'metadata',
          access: 'host',
          sessionIds: [],
          callsPerMinute: 60,
          callsPerHour: 1000,
        },
      },
      async () => password,
    );
    try {
      await assert.rejects(
        mongo ? metadataOnly.mongo(base, signal) : metadataOnly.query(base.sql!, signal),
        { code: 'POLICY_DENIED' },
      );
      assert.equal(
        (await metadataOnly.inspect({ action: 'capabilities' }, signal)).capabilities?.operations
          .length,
        1,
      );
    } finally {
      await metadataOnly.close();
    }

    step('database-enforced read-only account, policy rejection and authentication errors');
    if (mongo) {
      await assert.rejects(
        withMongo(instance, false, (client) =>
          client
            .db('dsh_test')
            .collection('dsh_test_items')
            .updateOne({ id: 1 }, { $set: { note: 'must not write' } }),
        ),
        { code: 13 },
      );
      await assert.rejects(
        runner.mongo(
          {
            operation: 'aggregate',
            collection: 'dsh_test_items',
            pipeline: [{ $out: 'forbidden' }],
          },
          signal,
        ),
        { code: 'READ_ONLY_VIOLATION' },
      );
    } else {
      await assert.rejects(
        withSql(instance, false, ({ sql }) =>
          sql(`UPDATE ${selectedTable} SET amount=amount WHERE id=1`),
        ),
        (error: any) => {
          assert(
            ['ER_TABLEACCESS_DENIED_ERROR', '42501', 'ORA-01031', 'ORA-41900'].includes(
              error.code,
            ) || error.number === 229,
          );
          return true;
        },
      );
      await assert.rejects(runner.query(`DELETE FROM ${selectedTable}`, signal), {
        code: 'READ_ONLY_VIOLATION',
      });
      await assert.rejects(
        runner.query(`SELECT missing_column FROM ${selectedTable}`, signal),
        (error: any) => {
          assert(error instanceof DatabaseError);
          assert(!JSON.stringify(error).includes(password));
          return true;
        },
      );
    }
    const bad = new QueryRunner(settings, async () => randomBytes(24).toString('hex'));
    try {
      await assert.rejects(bad.test(signal), (error: any) => {
        assert(
          ['ER_ACCESS_DENIED_ERROR', '28P01', 'ELOGIN', 'ORA-01017', '18'].includes(error.code),
        );
        return true;
      });
    } finally {
      await bad.close();
    }
    assert.equal((await read()).rowCount, 2);

    step('real MCP discovery, canonical JSON/text and rejected writes');
    const mcp = await connectDatabaseMcp(
      'Docker fixture',
      (sql, parent) => runner.query(sql, AbortSignal.any([signal, parent])),
      mongo ? (input, parent) => runner.mongo(input, AbortSignal.any([signal, parent])) : undefined,
    );
    try {
      assert.deepEqual(
        (await mcp.client.listTools()).tools.map((tool) => tool.name),
        ['query'],
      );
      const response = await mcp.client.callTool({ name: 'query', arguments: base });
      assert.equal(response.isError, undefined);
      const structured = queryResult.parse(response.structuredContent);
      assert.equal(structured.rowCount, 2);
      const content = response.content as { type: string; text?: string }[];
      assert.deepEqual(JSON.parse(content[0]!.text!), structured);
      assert(!JSON.stringify(response).includes(password));
      const rejected = await mcp.client.callTool({
        name: 'query',
        arguments: mongo
          ? {
              operation: 'aggregate',
              collection: 'dsh_test_items',
              pipeline: [{ $out: 'forbidden' }],
            }
          : { sql: `DELETE FROM ${selectedTable}` },
      });
      assert.equal(rejected.isError, true);
    } finally {
      await mcp.close();
    }

    step('actual DSH API → credentials → ToolRuntime → MCP → database; disable/delete/unload');
    const directory = await mkdtemp(join(tmpdir(), 'dsh-database-docker-'));
    let app: Awaited<ReturnType<typeof harness>> | undefined;
    try {
      app = await harness(directory);
      const saved = await app.api({ action: 'save', connection: { ...settings, password } });
      let record = saved.connections[0];
      const enabled = await app.api({
        action: 'toggle',
        id: record.id,
        revision: record.revision,
        enabled: true,
      });
      record = enabled.connections[0];
      const outcome = await app.ctx.tools.execute({
        name: record.toolName,
        callId: ToolCallId(`docker-${engine}`),
        arguments: base,
        signal,
      });
      assert(!outcome.isError);
      assert.equal(queryResult.parse(outcome.value).rowCount, 2);
      assert(!JSON.stringify(outcome).includes(password));
      const inspected = await app.ctx.tools.execute({
        name: record.inspectToolName,
        callId: ToolCallId(`docker-inspect-${engine}`),
        arguments: { action: 'capabilities' },
        signal,
      });
      assert(!inspected.isError);
      const observed = await app.api({ action: 'observations', id: record.id });
      assert.equal(observed.observations.records.length, 2);
      assert(observed.observations.records.every((r: any) => r.finalHostOutcome));
      assert(!JSON.stringify(observed).includes('SELECT'));
      const diagnosis = await app.api({
        action: 'diagnose',
        id: record.id,
        revision: record.revision,
      });
      assert.equal(diagnosis.observations.records[0].outcome, 'success');
      const disabled = await app.api({
        action: 'toggle',
        id: record.id,
        revision: record.revision,
        enabled: false,
      });
      assert.equal(app.ctx.tools.schemas().length, 0);
      record = disabled.connections[0];
      await app.api({ action: 'remove', id: record.id, revision: record.revision });
      assert.equal((await app.api({ action: 'list' })).connections.length, 0);
    } finally {
      try {
        await app?.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }

    if (['mysql', 'mariadb', 'postgresql'].includes(engine)) {
      step('server query timeout, in-flight cancellation, close and reconnect');
      // The product deliberately rejects all PG_* calls, including pg_sleep. Keep that policy:
      // exercise cancellation with an ordinary read-only aggregate instead of weakening it.
      const slowSql =
        engine === 'postgresql'
          ? 'SELECT SUM(n) FROM generate_series(1, 100000000) AS sample(n)'
          : 'SELECT SLEEP(10)';
      const short = new QueryRunner({ ...settings, timeoutMs: 700 }, async () => password);
      try {
        await assert.rejects(short.query(slowSql, signal), { code: 'TIMEOUT' });
      } finally {
        await short.close();
      }
      const controller = new AbortController();
      const pending = runner.query(slowSql, AbortSignal.any([signal, controller.signal]));
      const timer = setTimeout(() => controller.abort(), 300);
      try {
        await assert.rejects(pending, { code: 'CANCELED' });
      } finally {
        clearTimeout(timer);
      }
      assert.equal((await read()).rowCount, 2);
      const active = runner.query(slowSql, signal);
      const closing = new Promise<void>((resolve, reject) =>
        setTimeout(() => runner.close().then(resolve, reject), 300),
      );
      await Promise.all([assert.rejects(active, { code: 'CANCELED' }), closing]);
    } else {
      if (mongo) {
        step(
          'server-observed runner and Host in-flight cancellation, timeout, retirement and recovery',
        );
        await exerciseMongoCancellation(instance);
      }
      const canceled = new AbortController();
      canceled.abort();
      await assert.rejects(runner.test(canceled.signal), { code: 'CANCELED' });
    }
    await runner.close();
    await assert.rejects(runner.test(), { code: 'CONNECTION_DISABLED' });
    if (!mongo) {
      step('server has no remaining test-user sessions');
      const sql = {
        mysql: "SELECT COUNT(*) FROM information_schema.processlist WHERE user='dsh_reader'",
        mariadb: "SELECT COUNT(*) FROM information_schema.processlist WHERE user='dsh_reader'",
        postgresql: "SELECT COUNT(*) FROM pg_stat_activity WHERE usename='dsh_reader'",
        sqlserver: "SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE login_name='dsh_reader'",
        oracle: "SELECT COUNT(*) FROM v$session WHERE username='DSH_READER'",
        mongodb: '',
      }[engine];
      let count = -1;
      for (let attempt = 0; attempt < 10; attempt++) {
        count = await withSql(instance, true, async (client) =>
          Number((await client.sql(sql))[0]?.[0]),
        );
        if (!count) break;
        await delay(200, undefined, { signal });
      }
      if (count && engine === 'postgresql') {
        const remaining = await withSql(instance, true, (client) =>
          client.sql(
            "SELECT state, wait_event_type, wait_event, application_name, ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - query_start))) FROM pg_stat_activity WHERE usename='dsh_reader'",
          ),
        );
        // No SQL text, credentials or business rows: retain useful cleanup-failure evidence.
        console.error(`PostgreSQL remaining session states: ${JSON.stringify(remaining)}`);
      }
      assert.equal(count, 0);
    }
  } finally {
    await runner.close();
  }
}
