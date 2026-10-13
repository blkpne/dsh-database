import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import mysql from 'mysql2';
import oracledb from 'oracledb';
import mongodb from 'mongodb';
import tedious from 'tedious';
import { connectionInput } from '../src/schema.js';
import { QueryRunner } from '../src/query.js';

const base = {
  name: 'Driver fixture',
  host: 'localhost',
  user: 'reader',
  database: 'example',
  maxRows: 2,
  timeoutMs: 1000,
};

test('MySQL/MariaDB adapter streams in a read-only session with precision flags and closes at cap', async (t) => {
  for (const engine of ['mysql', 'mariadb'] as const) {
    const statements: string[] = [];
    let destroyed = 0;
    let options: any;
    const connection = Object.assign(new EventEmitter(), {
      connect: (callback: () => void) => queueMicrotask(callback),
      threadId: 42,
      destroy: () => {
        destroyed++;
      },
      query(sql: string, callback?: (error?: unknown) => void) {
        statements.push(sql);
        const command = new EventEmitter();
        queueMicrotask(() => {
          if (callback) callback();
          else {
            command.emit('fields', [{ name: 'x' }, { name: 'x' }]);
            for (const row of [
              ['9007199254740993', '1.001'],
              ['2', '3'],
              ['4', '5'],
            ])
              command.emit('result', row);
            command.emit('end');
          }
        });
        return command;
      },
    });
    const mock = t.mock.method(mysql, 'createConnection', ((config: any) => {
      options = config;
      return connection;
    }) as any);
    const runner = new QueryRunner(
      connectionInput.parse({ ...base, engine }),
      async () => 'fixture',
    );
    try {
      const result = await runner.query('SELECT 1');
      assert.deepEqual(statements.slice(0, 2), [
        'SET SESSION TRANSACTION READ ONLY',
        'START TRANSACTION READ ONLY',
      ]);
      assert(result.truncated);
      assert(statements.includes('KILL QUERY 42'));
      assert.equal(result.rows[0]![0], '9007199254740993');
      assert.deepEqual(result.columns, ['x', 'x']);
      assert.equal(options.bigNumberStrings, true);
      assert.equal(options.multipleStatements, false);
      assert(destroyed > 0);
    } finally {
      await runner.close();
      mock.mock.restore();
    }
  }
});

test('MySQL cancellation awaits its bounded control query before releasing the original session', async (t) => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let controlStarted!: () => void;
  const controlling = new Promise<void>((resolve) => {
    controlStarted = resolve;
  });
  let release!: () => void;
  let originalClosed = false;
  let controlClosed = false;
  const original = Object.assign(new EventEmitter(), {
    connect: (callback: () => void) => queueMicrotask(callback),
    threadId: 123,
    destroy() {
      originalClosed = true;
    },
    query(_sql: string, callback?: () => void) {
      if (callback) queueMicrotask(callback);
      else started();
      return new EventEmitter();
    },
  });
  const control = Object.assign(new EventEmitter(), {
    destroy() {
      controlClosed = true;
    },
    query(sql: string, callback: () => void) {
      assert.equal(sql, 'KILL QUERY 123');
      assert.equal(originalClosed, false);
      release = callback;
      controlStarted();
    },
  });
  let created = 0;
  t.mock.method(mysql, 'createConnection', ((options: mysql.ConnectionOptions) => {
    if (++created === 1) return original;
    assert.equal(options.connectTimeout, 1000);
    assert.equal(options.user, base.user);
    return control;
  }) as any);
  const runner = new QueryRunner(connectionInput.parse(base), async () => 'fixture');
  const controller = new AbortController();
  const request = runner.query('SELECT 1', controller.signal);
  const rejected = assert.rejects(request, { code: 'CANCELED' });
  try {
    await ready;
    controller.abort();
    await controlling;
    assert.equal(originalClosed, false);
    assert.equal(controlClosed, false);
    release();
    await rejected;
    assert.equal(originalClosed, true);
    assert.equal(controlClosed, true);
  } finally {
    release?.();
    await runner.close();
  }
});

test('PostgreSQL adapter streams without buffering, preserves zero-row metadata and terminates its owned backend', async (t) => {
  const statements: string[] = [];
  const clients: FakeClient[] = [];
  let empty = false;
  class FakeClient extends EventEmitter {
    closed = false;
    constructor(public options: any) {
      super();
      clients.push(this);
    }
    async connect() {}
    async end() {
      this.closed = true;
    }
    query(query: string | pg.Query, values?: unknown[]) {
      if (typeof query === 'string') {
        statements.push(query);
        if (query.includes('pg_terminate_backend')) assert.deepEqual(values, [123]);
        return Promise.resolve({ rows: [{ pid: 123 }] });
      }
      queueMicrotask(() => {
        const fields = [{ name: 'amount' }];
        if (!empty)
          for (const row of [['12345678901234567890.01'], ['2'], ['3']])
            query.emit('row', row, { fields });
        query.emit('end', { fields });
      });
      return query;
    }
  }
  t.mock.method(pg, 'Client', function (options: any) {
    return new FakeClient(options);
  } as any);
  const runner = new QueryRunner(
    connectionInput.parse({ ...base, engine: 'postgresql', tls: true }),
    async () => 'fixture',
  );
  try {
    const capped = await runner.query('SELECT 1');
    assert(capped.truncated);
    assert.equal(capped.rowCount, 2);
    assert(statements.includes('BEGIN READ ONLY'));
    assert(statements.includes('SELECT pg_terminate_backend($1)'));
    assert(clients.every((c) => c.closed));
    assert(clients.every((c) => c.options.ssl.rejectUnauthorized));
    empty = true;
    const zero = await runner.query('SELECT 1 WHERE false');
    assert.deepEqual(zero.columns, ['amount']);
    assert.equal(zero.rowCount, 0);
    assert(!zero.truncated);
  } finally {
    await runner.close();
  }
});

test('Oracle adapter uses read-only transactions, fetches incrementally and closes result sets', async (t) => {
  const statements: string[] = [];
  let connectionOptions: any;
  let queryOptions: any;
  let closed = 0;
  let cursorClosed = 0;
  const connection = {
    callTimeout: 0,
    async break() {},
    async close() {
      closed++;
    },
    async execute(sql: string, _args?: unknown, options?: unknown) {
      statements.push(sql);
      if (!options) return {};
      queryOptions = options;
      let read = false;
      return {
        metaData: [{ name: 'N' }],
        resultSet: {
          async getRows() {
            if (read) return [];
            read = true;
            return [['9007199254740993.01'], ['2'], ['3']];
          },
          async close() {
            cursorClosed++;
          },
        },
      };
    },
  };
  t.mock.method(oracledb, 'getConnection', (async (options: any) => {
    connectionOptions = options;
    return connection;
  }) as any);
  const runner = new QueryRunner(
    connectionInput.parse({ ...base, engine: 'oracle', tls: true }),
    async () => 'fixture',
  );
  try {
    const result = await runner.query('SELECT 1 FROM DUAL; -- trailing');
    assert.deepEqual(statements, ['SET TRANSACTION READ ONLY', 'SELECT 1 FROM DUAL']);
    assert(result.truncated);
    assert.equal(result.rows[0]![0], '9007199254740993.01');
    assert.equal(
      queryOptions.fetchTypeHandler({ dbType: oracledb.DB_TYPE_NUMBER }).type,
      oracledb.DB_TYPE_VARCHAR,
    );
    assert.match(connectionOptions.connectString, /^tcps:\/\/localhost:/);
    assert.equal(connectionOptions.sslServerDNMatch, true);
    assert.equal(closed, 1);
    assert.equal(cursorClosed, 1);
  } finally {
    await runner.close();
  }
});

test('Oracle late connect and in-flight cancellation remain owned until cleanup', async (t) => {
  let release!: () => void;
  let connected!: () => void;
  let closed = false;
  let executed = false;
  const ready = new Promise<void>((r) => {
    connected = r;
  });
  t.mock.method(oracledb, 'getConnection', (async () => {
    connected();
    await new Promise<void>((r) => {
      release = r;
    });
    return {
      callTimeout: 0,
      async execute() {
        executed = true;
      },
      async close() {
        closed = true;
      },
    };
  }) as any);
  const runner = new QueryRunner(
    connectionInput.parse({ ...base, engine: 'oracle' }),
    async () => '',
  );
  const pending = assert.rejects(runner.query('SELECT 1 FROM DUAL'), { code: 'CANCELED' });
  await ready;
  let settled = false;
  const stopping = runner.close().then(() => {
    settled = true;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false);
  release();
  await stopping;
  await pending;
  assert(closed);
  assert.equal(executed, false);
});

test('SQL Server adapter cancels at row cap and rejects precision-losing numeric values', async (t) => {
  let closed = 0;
  let canceled = 0;
  let decimal = false;
  t.mock.method(tedious.Connection.prototype, 'connect', function (
    this: tedious.Connection,
    callback: any,
  ) {
    assert.equal((this as any).config.server, 'localhost');
    queueMicrotask(() => callback());
  } as any);
  t.mock.method(tedious.Connection.prototype, 'close', function (this: tedious.Connection) {
    closed++;
    this.emit('end');
  });
  t.mock.method(tedious.Connection.prototype, 'execSql', function (request: tedious.Request) {
    request.on('cancel', () => {
      canceled++;
      request.callback(new Error('canceled'));
    });
    queueMicrotask(() => {
      (request as EventEmitter).emit('columnMetadata', [{ colName: 'x' }, { colName: 'x' }]);
      for (const value of [1, 2, 3]) {
        if (request.canceled) break;
        request.emit('row', [
          {
            value: decimal ? 1.2345678901234567 : value,
            metadata: { type: { name: decimal ? 'DecimalN' : 'Int' } },
          },
        ]);
      }
      if (!request.canceled) request.callback(null, 3);
    });
  });
  const runner = new QueryRunner(
    connectionInput.parse({ ...base, engine: 'sqlserver' }),
    async () => '',
  );
  try {
    const result = await runner.query('SELECT 1');
    assert(result.truncated);
    assert.equal(result.rowCount, 2);
    assert.equal(canceled, 1);
    decimal = true;
    await assert.rejects(runner.query('SELECT 1'), { code: 'UNSUPPORTED_TYPE' });
    assert.equal(canceled, 2);
    assert.equal(closed, 2);
  } finally {
    await runner.close();
  }
});

test('MongoDB adapter binds typed Extended JSON, applies limits and closes every cursor/client', async (t) => {
  const options: any[] = [];
  let closed = 0;
  let cursorClosed = 0;
  let filter: any;
  let limit = 0;
  const cursor = {
    limit(value: number) {
      limit = value;
      return this;
    },
    async close() {
      cursorClosed++;
    },
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < 3; i++)
        yield {
          _id: new mongodb.ObjectId('0123456789abcdef01234567'),
          n: mongodb.Long.fromString('9007199254740993'),
        };
    },
  };
  t.mock.method(
    mongodb.MongoClient.prototype,
    'connect',
    async function (this: mongodb.MongoClient) {
      assert.equal(this.options.hosts[0]?.host, 'localhost');
      return this;
    },
  );
  t.mock.method(mongodb.MongoClient.prototype, 'close', async () => {
    closed++;
  });
  t.mock.method(mongodb.MongoClient.prototype, 'db', (() => ({
    collection: () => ({
      find(value: any, opts: any) {
        filter = value;
        options.push(opts);
        return cursor;
      },
      aggregate(_pipeline: any, opts: any) {
        options.push(opts);
        return cursor;
      },
      async countDocuments(_filter: any, opts: any) {
        options.push(opts);
        return 42;
      },
    }),
    listCollections(_filter: any, opts: any) {
      options.push(opts);
      return cursor;
    },
  })) as any);
  const runner = new QueryRunner(
    connectionInput.parse({ ...base, engine: 'mongodb' }),
    async () => '',
  );
  try {
    const result = await runner.mongo({
      operation: 'find',
      collection: 'x',
      filter: { _id: { $oid: '0123456789abcdef01234567' } },
    });
    assert(filter._id instanceof mongodb.ObjectId);
    assert.equal(limit, 3);
    assert(result.truncated);
    assert.deepEqual((result.rows[0]![0] as any).n, { $numberLong: '9007199254740993' });
    const count = await runner.mongo({ operation: 'count', collection: 'x' });
    assert.deepEqual(count.rows, [[42]]);
    await runner.mongo({ operation: 'aggregate', collection: 'x', pipeline: [{ $limit: 1 }] });
    assert.equal(closed, 3);
    assert.equal(cursorClosed, 2);
    assert(options.every((o) => o.signal && o.maxTimeMS === 1000));
    assert.equal(options[2].allowDiskUse, false);
  } finally {
    await runner.close();
  }
});

test('Oracle executing query receives break and closes on unload', async (t) => {
  let started!: () => void;
  let rejectQuery!: (error: Error) => void;
  let breaks = 0;
  let closed = false;
  const ready = new Promise<void>((r) => {
    started = r;
  });
  t.mock.method(oracledb, 'getConnection', (async () => ({
    callTimeout: 0,
    execute(sql: string) {
      if (sql === 'SET TRANSACTION READ ONLY') return Promise.resolve({});
      started();
      return new Promise((_r, reject) => {
        rejectQuery = reject;
      });
    },
    async break() {
      breaks++;
      rejectQuery(new Error('interrupted'));
    },
    async close() {
      closed = true;
    },
  })) as any);
  const runner = new QueryRunner(
    connectionInput.parse({ ...base, engine: 'oracle' }),
    async () => '',
  );
  const query = assert.rejects(runner.query('SELECT 1 FROM DUAL'), { code: 'CANCELED' });
  await ready;
  await runner.close();
  await query;
  assert.equal(breaks, 1);
  assert(closed);
});

test('MongoDB waits for a late connect after early close and closes the late client', async (t) => {
  let started!: () => void;
  let release!: () => void;
  let closes = 0;
  let connected = false;
  const ready = new Promise<void>((r) => {
    started = r;
  });
  t.mock.method(
    mongodb.MongoClient.prototype,
    'connect',
    async function (this: mongodb.MongoClient) {
      started();
      await new Promise<void>((r) => {
        release = r;
      });
      connected = true;
      return this;
    },
  );
  t.mock.method(mongodb.MongoClient.prototype, 'close', async () => {
    closes++;
  });
  const runner = new QueryRunner(
    connectionInput.parse({ ...base, engine: 'mongodb' }),
    async () => '',
  );
  const query = assert.rejects(runner.mongo({ operation: 'listCollections' }), {
    code: 'CANCELED',
  });
  await ready;
  let done = false;
  const stop = runner.close().then(() => {
    done = true;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false);
  assert.equal(closes, 1);
  release();
  await stop;
  await query;
  assert(connected);
  assert.equal(closes, 2);
});

test('PostgreSQL wire parsing preserves scalar and multidimensional array precision', async (t) => {
  let wire = { oid: 1700, value: '9007199254740993.123456789' };
  class WireClient extends EventEmitter {
    async connect() {}
    async end() {}
    query(query: string | pg.Query) {
      if (typeof query === 'string') return Promise.resolve({ rows: [{ pid: 123 }] });
      queueMicrotask(() => {
        // Exercise the actual pg.Query type parser with protocol-shaped input.
        const parsed = query as any;
        parsed.handleRowDescription({
          fields: [{ name: 'value', dataTypeID: wire.oid, format: 'text' }],
        });
        parsed.handleDataRow({ fields: [wire.value] });
        parsed.handleCommandComplete({ text: 'SELECT 1' }, {});
        parsed.handleReadyForQuery({});
      });
      return query;
    }
  }
  t.mock.method(pg, 'Client', function () {
    return new WireClient();
  } as any);
  const runner = new QueryRunner(
    connectionInput.parse({ ...base, engine: 'postgresql' }),
    async () => '',
  );
  try {
    for (const sample of [
      { oid: 1700, value: '9007199254740993.123456789' },
      { oid: 1231, value: '{{9007199254740993.123456789,NULL},{-0.000000000000000001,1.20}}' },
      { oid: 1016, value: '{9007199254740993,NULL}' },
      { oid: 1115, value: '{"2026-10-18 01:02:03.123456"}' },
      { oid: 1185, value: '{"2026-10-18 01:02:03.123456+08"}' },
      { oid: 1182, value: '[0:1]={2026-10-18,infinity}' },
      { oid: 199, value: '{"{\\"amount\\":9007199254740993}",NULL}' },
      { oid: 3807, value: '{"{\\"amount\\":9007199254740993}",NULL}' },
      { oid: 1231, value: '{}' },
    ]) {
      wire = sample;
      const result = await runner.query('SELECT value FROM fixture');
      assert.deepEqual(result.rows, [[wire.value]], `OID ${wire.oid}`);
      assert.equal(result.truncated, false);
    }
  } finally {
    await runner.close();
  }
});
