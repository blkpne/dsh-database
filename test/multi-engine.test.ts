import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectionInput, connectionRecord, safeError } from '../src/schema.js';
import { engines } from '../src/engines.js';
import { validateReadOnlySql } from '../src/sql.js';
import { validateMongoQuery } from '../src/mongo.js';
import { ResultCollector, MAX_CELL_BYTES } from '../src/result.js';
import { QueryRunner } from '../src/query.js';
import { connectDatabaseMcp } from '../src/mcp.js';
import { emptyDraft, switchEngine, hasChanges, toDraft } from '../src/client/model.js';
import type { Adapter } from '../src/adapters/types.js';

const input = { name: 'Test', host: 'localhost', user: 'reader', database: 'example' };
test('MySQL records decode schema defaults; engine-specific configuration is validated', () => {
  const record = connectionRecord.parse({
    ...input,
    id: '0123456789abcdef',
    enabled: true,
    revision: 7,
    passwordRef: 'DSH_DATABASE_AABB',
    createdAt: '',
    updatedAt: '',
  });
  assert.equal(record.engine, 'mysql');
  assert.equal(record.port, 3306);
  assert.equal(record.revision, 7);
  for (const [engine, info] of Object.entries(engines))
    assert.equal(connectionInput.parse({ ...input, engine }).port, info.port);
  for (const engine of ['postgresql', 'oracle', 'mongodb'])
    assert.throws(() => connectionInput.parse({ ...input, engine, database: '' }));
  assert.throws(() =>
    connectionInput.parse({
      ...input,
      engine: 'oracle',
      database: 'x?transport_connect_timeout=0',
    }),
  );
  assert.throws(() => connectionInput.parse({ ...input, engine: 'mysql', authSource: 'admin' }));
  assert.throws(() =>
    connectionInput.parse({ ...input, engine: 'mongodb', mongoSrv: true, tls: false }),
  );
  assert.throws(() =>
    connectionInput.parse({
      ...input,
      engine: 'mongodb',
      mongoSrv: true,
      tls: true,
      host: 'cluster.example',
      port: 1234,
    }),
  );
  assert.throws(() => connectionInput.parse({ ...input, engine: 'mongodb', database: 'x/y' }));
  assert.equal(connectionInput.parse({ ...input, engine: 'mongodb', user: '' }).user, '');
});

for (const engine of ['postgresql', 'sqlserver', 'oracle'] as const) {
  test(`${engine} dialect accepts reads and rejects write/side-effect/quoting bypasses`, () => {
    for (const sql of [
      'SELECT 1',
      'WITH x AS (SELECT 1 AS n) SELECT * FROM x',
      'SELECT "update" FROM "t"',
      "SELECT 'DELETE; harmless' AS label",
      'SELECT 1; -- final',
    ])
      assert(validateReadOnlySql(sql, engine));
    if (engine === 'sqlserver') assert(validateReadOnlySql('SELECT [a]]b] FROM [t]', engine));
    for (const sql of [
      'SELECT 1; DELETE FROM x',
      'WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x',
      'SELECT * INTO x FROM y',
      'SELECT 1 EXEC sp_who',
      "SELECT 1 WAITFOR DELAY '00:01'",
      "SELECT nextval('x')",
      'SELECT x.nextval FROM DUAL',
      "SELECT pg_read_file('/tmp/x')",
      'SELECT "pg_read_file"(\'/tmp/x\')',
      "SELECT set_config('x','y',false)",
      "SELECT UTL_HTTP.REQUEST('http://x') FROM DUAL",
      'SELECT * FROM OPENROWSET(a)',
      'SELECT * FROM [OPENQUERY](x)',
      'SELECT 1 FOR UPDATE',
      'SELECT 1 # not a comment',
      'SELECT 1 /* nested /* */ DELETE */',
      'SELECT $$; DELETE FROM x$$',
      "SELECT q'[a' INTO x]' FROM DUAL",
      'EXPLAIN ANALYZE SELECT 1',
    ])
      assert.throws(() => validateReadOnlySql(sql, engine), { code: 'READ_ONLY_VIOLATION' }, sql);
  });
}

test('MongoDB validates operation-specific input, nested pipelines, JavaScript and writes', () => {
  for (const query of [
    { operation: 'listCollections' },
    {
      operation: 'find',
      collection: 'events',
      filter: { _id: { $oid: '0123456789abcdef01234567' } },
    },
    { operation: 'count', collection: 'events' },
    {
      operation: 'aggregate',
      collection: 'events',
      pipeline: [
        { $match: { active: true } },
        { $group: { _id: '$region', count: { $sum: 1 } } },
        { $facet: { first: [{ $limit: 1 }] } },
      ],
    },
  ])
    assert(validateMongoQuery(query));
  for (const query of [
    { operation: 'command' },
    { operation: 'find' },
    { operation: 'listCollections', filter: {} },
    { operation: 'count', collection: 'x', limit: 1 },
    { operation: 'find', collection: 'system.users' },
    { operation: 'aggregate', collection: 'x' },
    { operation: 'find', collection: 'x', filter: { $where: 'return true' } },
    { operation: 'aggregate', collection: 'x', pipeline: [{ $out: 'sink' }] },
    {
      operation: 'aggregate',
      collection: 'x',
      pipeline: [{ $facet: { nested: [{ $merge: 'sink' }] } }],
    },
    {
      operation: 'aggregate',
      collection: 'x',
      pipeline: [{ $project: { x: { $function: { body: 'return 1' } } } }],
    },
    {
      operation: 'aggregate',
      collection: 'x',
      pipeline: [{ $lookup: { from: 'other', pipeline: [{ $out: 'sink' }] } }],
    },
    { operation: 'find', collection: 'x', projection: { x: { $meta: 'textScore' } } },
  ])
    assert.throws(() => validateMongoQuery(query));
});

test('shared result budget preserves duplicate columns, bytes and whole cells', () => {
  const result = new ResultCollector(2);
  result.fields(['id', 'id']);
  assert(result.row([12345678901234567890n, Buffer.from('a')]));
  assert(result.row([null, new Date('2026-01-01T00:00:00Z')]));
  assert.equal(result.finish().truncated, false);
  assert.equal(result.row(['third']), false);
  assert.deepEqual(result.finish().columns, ['id', 'id']);
  assert.equal(result.finish().rows[0]![0], '12345678901234567890');
  const large = new ResultCollector(500);
  large.fields(['value']);
  assert.equal(large.row(['x'.repeat(MAX_CELL_BYTES)]), false);
  assert.equal(large.finish().rowCount, 0);
  assert(large.finish().truncated);
  const wide = new ResultCollector(1);
  wide.fields(['x'.repeat(300000)]);
  assert.equal(wide.row([1]), false);
  assert(wide.finish().truncated);
});

test('runner rejects invalid input before acquiring credentials or a driver', async () => {
  let called = false;
  const runner = new QueryRunner(
    connectionInput.parse({ ...input, engine: 'sqlserver' }),
    async () => {
      called = true;
      return '';
    },
  );
  await assert.rejects(runner.query('DELETE FROM x'));
  assert.equal(called, false);
  await runner.close();
});

test('runner owns cancellation and cleanup, limits concurrency, and reconnects after errors', async () => {
  let opened = 0,
    cleaned = 0;
  const execute: Adapter = async (_input, { signal, result }) => {
    opened++;
    try {
      await new Promise<void>((resolve, reject) => {
        if (opened === 1) {
          reject({ code: 'ELOGIN', message: 'private-password' });
          return;
        }
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      result.fields(['ok']);
      result.row([1]);
    } finally {
      await new Promise((resolve) => setImmediate(resolve));
      cleaned++;
    }
  };
  const runner = new QueryRunner(
    connectionInput.parse(input),
    async () => '',
    async () => execute,
  );
  await assert.rejects(
    runner.query('SELECT 1'),
    (error) => !String(error).includes('private-password'),
  );
  const first = runner.query('SELECT 1');
  const second = runner.query('SELECT 2');
  const errors = Promise.all([
    assert.rejects(first, { code: 'CANCELED' }),
    assert.rejects(second, { code: 'CANCELED' }),
  ]);
  await assert.rejects(runner.query('SELECT 3'), { code: 'BUSY' });
  await new Promise((resolve) => setImmediate(resolve));
  await runner.close();
  await errors;
  assert.equal(cleaned, 3);
  await assert.rejects(runner.query('SELECT 1'), { code: 'CONNECTION_DISABLED' });
});

test('timeout also bounds secret lookup and stops before opening a driver', async () => {
  let opened = false;
  const runner = new QueryRunner(
    connectionInput.parse({ ...input, timeoutMs: 100 }),
    () => new Promise(() => {}),
    async () => async () => {
      opened = true;
    },
  );
  await assert.rejects(runner.query('SELECT 1'), { code: 'TIMEOUT' });
  await runner.close();
  assert.equal(opened, false);
});

test('MongoDB uses real MCP schema and canonical structured results', async () => {
  let sqlCalled = false;
  const mcp = await connectDatabaseMcp(
    'Mongo test',
    async () => {
      sqlCalled = true;
      throw new Error('wrong executor');
    },
    async (input) => {
      validateMongoQuery(input);
      const result = new ResultCollector(1);
      result.fields(['document']);
      result.row([{ _id: { $oid: '0123456789abcdef01234567' } }]);
      return result.finish();
    },
  );
  try {
    const schema = (await mcp.client.listTools()).tools[0]!.inputSchema;
    assert(schema.properties?.operation);
    assert.equal(schema.properties?.sql, undefined);
    assert.equal(
      (await mcp.client.callTool({ name: 'query', arguments: { sql: 'SELECT 1' } })).isError,
      true,
    );
    const result = await mcp.client.callTool({
      name: 'query',
      arguments: { operation: 'find', collection: 'x' },
    });
    assert(result.structuredContent);
    assert.equal(sqlCalled, false);
    assert.equal(
      (
        await mcp.client.callTool({
          name: 'query',
          arguments: { operation: 'aggregate', collection: 'x', pipeline: [{ $out: 'x' }] },
        })
      ).isError,
      true,
    );
  } finally {
    await mcp.close();
  }
});

test('type switching adjusts defaults without overwriting a custom port', () => {
  const draft = switchEngine(emptyDraft(), 'postgresql');
  assert.equal(draft.port, 5432);
  assert(hasChanges(draft));
  assert.equal(switchEngine({ ...draft, port: 15432 }, 'oracle').port, 15432);
  assert.equal(
    switchEngine({ ...draft, authSource: 'admin', mongoSrv: true }, 'sqlserver').mongoSrv,
    false,
  );
  assert.equal(
    toDraft({
      ...emptyDraft(),
      id: 'x',
      revision: 1,
      enabled: false,
      hasPassword: true,
      toolName: 'x',
      status: 'disabled',
    }).password,
    '',
  );
});

test('driver errors for every engine stay redacted', () => {
  for (const code of ['28P01', '42501', 'ELOGIN', 'ORA-01017', 18, 13, 'unexpected']) {
    assert(
      !JSON.stringify(safeError({ code, message: 'private SQL password host' })).includes(
        'private',
      ),
    );
  }
});

test('MongoDB rejects excessive UTF-8, cycles, non-JSON values and deep objects before parsing', () => {
  const filter: Record<string, unknown> = {};
  filter.self = filter;
  let deep: unknown = 1;
  for (let i = 0; i < 10000; i++) deep = { child: deep };
  for (const value of [
    filter,
    { deep },
    { x: '中'.repeat(12000) },
    { x: Infinity },
    { x: 1n },
    { x: new Date() },
  ])
    assert.throws(() => validateMongoQuery({ operation: 'find', collection: 'x', filter: value }), {
      code: 'INVALID_INPUT',
    });
});

test('error codes cannot read inherited object properties', () => {
  for (const code of ['__proto__', 'constructor', 'toString'])
    assert.deepEqual(safeError({ code }), {
      code: 'DATABASE_ERROR',
      message: '数据库操作失败，请检查连接、查询语法和账户权限。',
    });
});

test('password clearing and replacement are mutually exclusive in save and connection-test inputs', () => {
  assert.throws(() =>
    connectionInput.parse({ ...input, password: 'fixture', clearPassword: true }),
  );
});
