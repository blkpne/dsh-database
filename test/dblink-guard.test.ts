import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReadOnlySql } from '../src/sql.js';
import { QueryRunner } from '../src/query.js';
import { connectionInput } from '../src/schema.js';
import type { Adapter } from '../src/adapters/types.js';

const names = [
  'dblink',
  'dblink_exec',
  'dblink_connect',
  'dblink_connect_u',
  'dblink_disconnect',
  'dblink_open',
  'dblink_fetch',
  'dblink_close',
  'dblink_get_connections',
  'dblink_error_message',
  'dblink_send_query',
  'dblink_is_busy',
  'dblink_get_result',
  'dblink_cancel_query',
  'dblink_get_pkey',
  'dblink_build_sql_insert',
  'dblink_build_sql_delete',
  'dblink_build_sql_update',
  'dblink_get_notify',
  'dblink_fdw_validator',
  'dblink_future_helper',
];
const blocked = names.flatMap((name) =>
  [name, name.toUpperCase(), name.replace('dblink', 'DbLiNk')].flatMap((variant) => [
    `SELECT ${variant}()`,
    `SELECT public.${variant}()`,
    `SELECT "${variant}"()`,
    `SELECT "public"."${variant}"()`,
    `SELECT public /* schema */ . "${variant}" /* call */ ()`,
    `WITH remote AS (SELECT ${variant}()) SELECT * FROM remote`,
  ]),
);

test('PostgreSQL rejects the complete dblink family regardless of case or qualification', () => {
  for (const sql of blocked)
    assert.throws(
      () => validateReadOnlySql(sql, 'postgresql'),
      { code: 'READ_ONLY_VIOLATION' },
      sql,
    );
});

test('dblink names inside strings and comments do not trigger the guard', () => {
  for (const name of names) {
    for (const sql of [
      `SELECT '${name}()' AS label`,
      `SELECT 'it''s public."${name}"()' AS label`,
      `SELECT 1 /* public."${name}"() */`,
      `SELECT 1 -- ${name}()`,
    ])
      assert.equal(validateReadOnlySql(sql, 'postgresql'), sql);
  }
  assert.equal(
    validateReadOnlySql('SELECT dblinked FROM t', 'postgresql'),
    'SELECT dblinked FROM t',
  );
});

test('runner rejects dblink before credentials, driver loading or execution', async () => {
  let credentials = 0;
  let loads = 0;
  let executions = 0;
  // This in-memory substitute never imports or opens a database driver.
  const execute: Adapter = async (_input, { result }) => {
    executions++;
    result.fields(['ok']);
    result.row([1]);
  };
  const runner = new QueryRunner(
    connectionInput.parse({
      name: 'Guard test',
      engine: 'postgresql',
      host: 'unused.invalid',
      user: 'reader',
      database: 'example',
    }),
    async () => {
      credentials++;
      return '';
    },
    async () => {
      loads++;
      return execute;
    },
  );
  try {
    for (const sql of blocked)
      await assert.rejects(runner.query(sql), { code: 'READ_ONLY_VIOLATION' }, sql);
    assert.deepEqual(
      { credentials, loads, executions },
      { credentials: 0, loads: 0, executions: 0 },
    );
    // A positive control proves the substitute is wired into the actual runner path.
    assert.deepEqual((await runner.query('SELECT 1')).rows, [[1]]);
    assert.deepEqual(
      { credentials, loads, executions },
      { credentials: 1, loads: 1, executions: 1 },
    );
  } finally {
    await runner.close();
  }
});
