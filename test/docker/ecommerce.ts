import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { QueryRunner } from '../../src/query.js';
import { config, withSql } from './fixtures.js';
import type { Instance } from './lifecycle.js';

// Execute the public example files against a disposable PostgreSQL container.
export async function exerciseEcommerceExample(instance: Instance) {
  if (instance.engine !== 'postgresql') return;
  const example = new URL('../../docs/examples/ecommerce/', import.meta.url);
  const seed = readFileSync(new URL('seed.sql', example), 'utf8');
  const queries = readFileSync(new URL('queries.sql', example), 'utf8')
    .split(';')
    .filter((sql) => sql.trim());
  const guide = readFileSync(new URL('README.md', example), 'utf8');
  const sqlBlocks = [...guide.matchAll(/```sql\n([\s\S]*?)```/g)].map((match) => match[1]!);
  const createRole = sqlBlocks.find((sql) => sql.startsWith('CREATE ROLE '))!;
  const grants = sqlBlocks.find((sql) => sql.startsWith('GRANT CONNECT '))!;
  assert.equal(createRole.trim(), 'CREATE ROLE dsh_example_reader LOGIN;');
  await withSql(instance, true, async ({ sql }) => {
    await sql('CREATE DATABASE dsh_database_example');
  });
  await withSql(
    instance,
    true,
    async ({ sql }) => {
      await sql(seed);
      await sql(createRole);
      await sql(grants);
      // The test harness generates this password; no user credential is read or emitted.
      assert.match(instance.password, /^[A-Za-z0-9_]+$/);
      await sql(`ALTER ROLE dsh_example_reader PASSWORD '${instance.password}'`);
      assert.deepEqual(await sql('SELECT COUNT(*) FROM public.orders'), [['1560']]);
      assert.deepEqual(await sql('SELECT COUNT(*) FROM public.refunds'), [['358']]);
      await assert.rejects(sql(seed), { code: '42P07' });
      await sql('ROLLBACK');
      assert.deepEqual(await sql('SELECT COUNT(*) FROM public.orders'), [['1560']]);
      await sql('SET ROLE dsh_example_reader');
      await assert.rejects(sql('DELETE FROM public.orders'), { code: '42501' });
      await assert.rejects(sql('CREATE TABLE public.should_not_exist (id integer)'), {
        code: '42501',
      });
    },
    'dsh_database_example',
  );
  const runner = new QueryRunner(
    {
      ...config(instance),
      database: 'dsh_database_example',
      user: 'dsh_example_reader',
      maxRows: 100,
    },
    async () => instance.password,
  );
  try {
    assert.equal(queries.length, 2);
    const monthly = await runner.query(queries[0]!);
    assert.equal(monthly.truncated, false);
    assert.deepEqual(
      monthly.rows.map(([month, ...metrics]) => [month, ...metrics.map(Number)]),
      [
        ['2026-01', 400, 100000, 5000, 95000, 5],
        ['2026-02', 500, 125000, 6250, 118750, 5],
        ['2026-03', 600, 150000, 18000, 132000, 12],
      ],
    );
    const channels = await runner.query(queries[1]!);
    assert.equal(channels.truncated, false);
    assert.deepEqual(
      channels.rows.map(([channel, rate]) => [channel, Number(rate)]),
      [
        ['付费广告', 12.75],
        ['老客复购', 3.69],
        ['自然搜索', 2.5],
      ],
    );
  } finally {
    await runner.close();
  }
  console.log('[postgresql] Public ecommerce example, read-only role and repeat-run guard PASS');
}
