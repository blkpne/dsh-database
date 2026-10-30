import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReadOnlySql } from '../src/sql.js';
import { safeError } from '../src/schema.js';

test('SQL Server accepts one query expression, including nested SELECTs and set operations', () => {
  for (const sql of [
    'SELECT TOP (10) [a]]b] FROM [orders]',
    'WITH x AS (SELECT 1 AS n), y AS (SELECT n FROM x) SELECT * FROM y',
    'SELECT (SELECT MAX(n) FROM t) AS n FROM t WHERE EXISTS (SELECT 1 FROM t)',
    'SELECT 1 UNION ALL SELECT 2',
    "SELECT 'SELECT 1; KILL 57' AS [SELECT] /* SELECT 2 */; -- end",
  ])
    assert(validateReadOnlySql(sql, 'sqlserver'), sql);
});

test('SQL Server accepts OFFSET/FETCH pagination while rejecting cursor FETCH batches', () => {
  for (const sql of [
    'SELECT id FROM dbo.orders ORDER BY id OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY',
    'select id from dbo.orders order by id offset 0 rows fetch next 1 row only',
    'WITH page AS (SELECT id FROM dbo.orders) SELECT id FROM page ORDER BY id OFFSET 2 ROWS FETCH NEXT 1 ROW ONLY',
  ])
    assert.equal(validateReadOnlySql(sql, 'sqlserver'), sql);
  for (const sql of [
    'SELECT 1 FETCH orders_cursor',
    'SELECT 1 FETCH NEXT FROM orders_cursor',
    'SELECT 1 FETCH PRIOR FROM GLOBAL orders_cursor',
    'SELECT 1 FETCH ABSOLUTE 2 FROM orders_cursor',
    'SELECT id FROM dbo.orders ORDER BY id OFFSET 0 ROWS FETCH NEXT 1 ROW ONLY SELECT 2',
  ])
    assert.throws(() => validateReadOnlySql(sql, 'sqlserver'), { code: 'READ_ONLY_VIOLATION' });
});

test('SQL Server rejects batches even without semicolons, and rejects all explicit locking hints', () => {
  for (const sql of [
    'SELECT 1\nSELECT 2',
    'SELECT 1 SELECT 2',
    'SELECT 1 /* boundary */ SELECT 2',
    'SELECT 1\nKILL 57',
    'SELECT 1\nCHECKPOINT',
    'SELECT 1--\rCHECKPOINT',
    'SELECT 1--\r\nCHECKPOINT',
    'SELECT 1--\rSHUTDOWN',
    'SELECT 1\nGO\nSELECT 2',
    ...['REVERT', 'RETURN', 'BREAK', 'CONTINUE', 'THROW'].map((word) => `SELECT 1\n${word}`),
    'WITH x AS (SELECT 1 AS n) SELECT * FROM x SELECT 2',
    'SELECT 1 UNION ALL SELECT 2 SELECT 3',
    'SELECT 1; SELECT 2',
    ...[
      'TABLOCKX',
      'XLOCK',
      'UPDLOCK',
      'HOLDLOCK',
      'TABLOCK',
      'PAGLOCK',
      'ROWLOCK',
      'READCOMMITTEDLOCK',
      'REPEATABLEREAD',
      'SERIALIZABLE',
    ].flatMap((hint) => [
      `SELECT * FROM dbo.orders WITH (${hint})`,
      `SELECT * FROM dbo.orders (${hint})`,
      `SELECT * FROM dbo.orders OPTION (TABLE HINT (dbo.orders, ${hint}))`,
    ]),
    'SELECT * FROM dbo.orders WITH ([TABLOCKX])',
    'SELECT * FROM dbo.orders ([XLOCK ])',
    'SELECT * FROM dbo.orders ("XLOCK ")',
    "SELECT * FROM [OPENQUERY ](missing_server, 'SELECT 1')",
    'SELECT * FROM [OPENROWSET ](provider, source, object)',
    'SELECT * FROM dbo.orders WITH ([UPDLOCK ], [HOLDLOCK ])',
  ])
    assert.throws(
      () => validateReadOnlySql(sql, 'sqlserver'),
      { code: 'READ_ONLY_VIOLATION' },
      sql,
    );
});

for (const sql of [
  'SELECT 1',
  'SELECT "update" AS label',
  "SELECT 'it''s fine; DELETE' AS text; -- end",
  'WITH x AS (SELECT 1 AS v UNION ALL SELECT 2) SELECT SUM(v) FROM x',
  'SELECT `create` FROM `table`',
  'SHOW DATABASES',
  'SHOW FULL TABLES FROM example',
  'SHOW CREATE TABLE example',
  "SHOW COLUMNS FROM t LIKE 'id'",
  'DESCRIBE example',
  'EXPLAIN SELECT 1',
  '/* ordinary comment */ SELECT 1;',
])
  test(`allows ${sql}`, () => assert.equal(validateReadOnlySql(sql), sql.trim()));

for (const sql of [
  '',
  'UPDATE t SET x=1',
  'DELETE FROM t',
  'DROP TABLE t',
  'SELECT 1; SELECT 2',
  'SELECT 1;;',
  'SELECT 1 INTO OUTFILE "/tmp/x"',
  'SELECT 1 FOR UPDATE',
  'WITH x AS (DELETE FROM t) SELECT * FROM x',
  'EXPLAIN ANALYZE DELETE FROM t',
  'CALL procedure()',
  'SELECT LOAD_FILE("/etc/passwd")',
  'SELECT GET_LOCK("x",1)',
  'SELECT @x := 1',
  'SELECT @@global.version',
  'SELECT 1 /*!50000 INTO OUTFILE "/tmp/x" */',
  'SELECT /*+ MAX_EXECUTION_TIME(0) */ 1',
  "SELECT 'bad\\' escape'",
  'SELECT "unterminated',
  'SELECT 1 /* unclosed',
  'SHOW PROCESSLIST',
  'SHOW GLOBAL VARIABLES',
  'SHOW CREATE USER user',
  'SELECT `GET_LOCK`("x",0)',
  'SELECT `LOAD_FILE`("/etc/passwd")',
])
  test(`rejects ${JSON.stringify(sql)}`, () =>
    assert.throws(() => validateReadOnlySql(sql), { code: 'READ_ONLY_VIOLATION' }));

test('does not leak raw driver messages or SQL through errors', () => {
  for (const code of ['ER_ACCESS_DENIED_ERROR', 'ER_PARSE_ERROR', 'UNEXPECTED']) {
    assert(
      !JSON.stringify(
        safeError({ code, message: 'secret-password SELECT sensitive-value' }),
      ).includes('secret'),
    );
  }
});

test('MariaDB executable and ambiguous nested comments never bypass the read-only policy', () => {
  for (const engine of ['mysql', 'mariadb'] as const)
    for (const sql of [
      'SELECT 1 /*M! INTO OUTFILE "target" */',
      'SELECT 1 /*M!100100 INTO OUTFILE "target" */',
      'SELECT 1 /* outer /* inner */ rest */',
    ])
      assert.throws(() => validateReadOnlySql(sql, engine), { code: 'READ_ONLY_VIOLATION' });
});
