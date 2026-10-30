import assert from 'node:assert/strict';
import type { Instance } from './lifecycle.js';
import { config, withSql } from './fixtures.js';
import { QueryRunner } from '../../src/query.js';

export async function exerciseColumnPermissions(instance: Instance): Promise<void> {
  if (instance.engine !== 'postgresql') return;
  console.log(
    '  postgresql: real column grants, inherited role, view, hidden schema and namespace pagination',
  );
  await withSql(instance, true, async ({ sql }) => {
    await sql('CREATE SCHEMA granted_schema');
    await sql('CREATE SCHEMA hidden_schema');
    await sql('CREATE TABLE granted_schema.items (id int, private_note text)');
    await sql("INSERT INTO granted_schema.items VALUES (1, 'fixture-private')");
    await sql(
      'CREATE VIEW granted_schema.item_view AS SELECT id, private_note FROM granted_schema.items',
    );
    await sql('CREATE TABLE hidden_schema.hidden (id int)');
    await sql('GRANT USAGE ON SCHEMA granted_schema TO dsh_reader');
    await sql('GRANT SELECT (id) ON granted_schema.items TO dsh_reader');
    await sql('GRANT SELECT (id) ON granted_schema.item_view TO dsh_reader');
  });
  const runner = new QueryRunner(
    { ...config(instance), maxRows: 10 },
    async () => instance.password,
  );
  const describe = () =>
    runner.inspect({ action: 'describe', schema: 'granted_schema', name: 'items', refresh: true });
  try {
    const namespaces = await runner.inspect({ action: 'namespaces', name: 'schema', limit: 1 });
    assert.deepEqual(namespaces.sections.namespaces?.rows, [['granted_schema']]);
    const hidden = await runner.inspect({ action: 'namespaces', name: 'hidden_schema' });
    assert.equal(hidden.sections.namespaces?.status, 'empty');
    const page1 = await runner.inspect({ action: 'namespaces', limit: 1 });
    assert.equal(page1.nextOffset, 1);
    const page2 = await runner.inspect({
      action: 'namespaces',
      limit: 1,
      offset: page1.nextOffset!,
    });
    assert.notDeepEqual(page1.sections.namespaces?.rows, page2.sections.namespaces?.rows);
    const found = await runner.inspect({
      action: 'search',
      schema: 'granted_schema',
      name: 'items',
    });
    assert.equal(found.sections.objects?.rows.length, 1);
    const onlyId = await describe();
    assert.deepEqual(
      onlyId.sections.columns?.rows.map((row) => row[0]),
      ['id'],
    );
    assert.equal(onlyId.sections.indexes?.status, 'denied');
    assert(!JSON.stringify(onlyId).includes('private_note'));
    assert.equal((await runner.query('SELECT id FROM granted_schema.items')).rowCount, 1);
    await assert.rejects(runner.query('SELECT private_note FROM granted_schema.items'), {
      code: '42501',
    });
    const view = await runner.inspect({
      action: 'describe',
      schema: 'granted_schema',
      name: 'item_view',
    });
    assert.deepEqual(
      view.sections.columns?.rows.map((row) => row[0]),
      ['id'],
    );
    await withSql(instance, true, async ({ sql }) => {
      await sql('REVOKE SELECT (id) ON granted_schema.items FROM dsh_reader');
      await sql('CREATE ROLE fixture_columns');
      await sql('GRANT SELECT (id) ON granted_schema.items TO fixture_columns');
      await sql('GRANT fixture_columns TO dsh_reader');
    });
    assert.deepEqual(
      (await describe()).sections.columns?.rows.map((row) => row[0]),
      ['id'],
    );
    await withSql(instance, true, async ({ sql }) => {
      await sql('REVOKE fixture_columns FROM dsh_reader');
    });
    assert.equal((await describe()).sections.columns?.status, 'empty');
    await withSql(instance, true, async ({ sql }) => {
      await sql('GRANT SELECT ON granted_schema.items TO dsh_reader');
    });
    const full = await describe();
    assert.deepEqual(
      full.sections.columns?.rows.map((row) => row[0]),
      ['id', 'private_note'],
    );
    assert.notEqual(full.sections.indexes?.status, 'denied');
    await withSql(instance, true, async ({ sql }) => {
      await sql('REVOKE USAGE ON SCHEMA granted_schema FROM dsh_reader');
    });
    assert.equal((await describe()).sections.columns?.status, 'empty');
  } finally {
    await runner.close();
  }
}

export async function exerciseOracleConstraints(instance: Instance): Promise<void> {
  if (instance.engine !== 'oracle') return;
  console.log('  oracle: composite constraints and metadata visibility after revoking access');
  await withSql(instance, true, async ({ sql }) => {
    await sql(
      'CREATE TABLE SYSTEM.dsh_keys_parent (a INTEGER,b INTEGER,CONSTRAINT dsh_keys_pk PRIMARY KEY(a,b))',
    );
    await sql(
      'CREATE TABLE SYSTEM.dsh_keys_child (id INTEGER PRIMARY KEY,x INTEGER,y INTEGER,CONSTRAINT dsh_keys_unique UNIQUE(x,y),CONSTRAINT dsh_keys_fk FOREIGN KEY(x,y) REFERENCES SYSTEM.dsh_keys_parent(a,b))',
    );
    await sql('CREATE TABLE SYSTEM.dsh_keys_hidden (id INTEGER PRIMARY KEY)');
    await sql('GRANT SELECT ON SYSTEM.dsh_keys_parent TO dsh_reader');
    await sql('GRANT SELECT ON SYSTEM.dsh_keys_child TO dsh_reader');
  });
  const runner = new QueryRunner(config(instance), async () => instance.password);
  const describe = (name: string) =>
    runner.inspect({ action: 'describe', schema: 'SYSTEM', name, refresh: true }, instance.signal);
  try {
    const parent = await describe('DSH_KEYS_PARENT');
    assert.deepEqual(
      parent.sections.keys?.rows.map((row) => [row[1], row[2], Number(row[3])]),
      [
        ['P', 'A', 1],
        ['P', 'B', 2],
      ],
    );
    const child = await describe('DSH_KEYS_CHILD');
    assert.deepEqual(
      child.sections.keys?.rows.filter((row) => row[1] === 'U').map((row) => row[2]),
      ['X', 'Y'],
    );
    assert.deepEqual(
      child.sections.foreignKeys?.rows.map((row) => [row[1], Number(row[2]), row[5], row[6]]),
      [
        ['X', 1, 'DSH_KEYS_PARENT', 'A'],
        ['Y', 2, 'DSH_KEYS_PARENT', 'B'],
      ],
    );
    await withSql(instance, true, async ({ sql }) => {
      await sql('REVOKE SELECT ON SYSTEM.dsh_keys_parent FROM dsh_reader');
    });
    const restricted = await describe('DSH_KEYS_CHILD');
    assert.equal(restricted.sections.foreignKeys?.rows.length, 2);
    assert(
      restricted.sections.foreignKeys?.rows.every((row) => row[5] === null && row[6] === null),
    );
    for (const name of ['DSH_KEYS_PARENT', 'DSH_KEYS_HIDDEN']) {
      const hidden = await describe(name);
      assert(Object.values(hidden.sections).every((section) => section.rows.length === 0));
    }
  } finally {
    await runner.close();
  }
}
