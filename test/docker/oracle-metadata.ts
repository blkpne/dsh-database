import assert from 'node:assert/strict';
import oracledb from 'oracledb';
import { setTimeout as delay } from 'node:timers/promises';
import type { Instance } from './lifecycle.js';
import { withSql, config } from './fixtures.js';
import { QueryRunner } from '../../src/query.js';

export const longOwner = 'Target_' + 't'.repeat(100);
export const longConstraint = 'Pk_' + 'p'.repeat(115);
export const oracleLongColdInput = {
  action: 'describe',
  schema: 'DSH_SOURCE_OWNER',
  name: 'LongChild',
  refresh: true,
};
export const oracleColdInput = {
  action: 'describe',
  schema: 'DSH_SOURCE_OWNER',
  name: 'CHILD',
  refresh: true,
};
export async function seedOracleMetadata(instance: Instance): Promise<void> {
  if (instance.engine !== 'oracle') return;
  await withSql(instance, true, async ({ sql }) => {
    for (const owner of ['dsh_source_owner', 'dsh_target_owner'])
      await sql(
        `CREATE USER ${owner} NO AUTHENTICATION DEFAULT TABLESPACE SYSTEM QUOTA 1M ON SYSTEM`,
      );
    await sql(
      'CREATE TABLE dsh_target_owner.parent (a INTEGER,b INTEGER,c INTEGER,d INTEGER,CONSTRAINT cross_pk PRIMARY KEY(a,b),CONSTRAINT alternate_uk UNIQUE(c,d))',
    );
    await sql('GRANT REFERENCES ON dsh_target_owner.parent TO dsh_source_owner');
    await sql(
      'CREATE TABLE dsh_source_owner.child (id INTEGER PRIMARY KEY,x INTEGER,y INTEGER,CONSTRAINT cross_uk UNIQUE(x,y),CONSTRAINT cross_fk FOREIGN KEY(x,y) REFERENCES dsh_target_owner.parent(a,b))',
    );
    await sql('GRANT SELECT ON dsh_source_owner.child TO dsh_reader');
    await sql('GRANT SELECT ON dsh_target_owner.parent TO dsh_reader');
    await sql(
      `CREATE USER "${longOwner}" NO AUTHENTICATION DEFAULT TABLESPACE SYSTEM QUOTA 1M ON SYSTEM`,
    );
    await sql(
      `CREATE TABLE "${longOwner}"."LongParent" ("ParentColumn" INTEGER,CONSTRAINT "${longConstraint}" PRIMARY KEY("ParentColumn"))`,
    );
    await sql(`GRANT REFERENCES ON "${longOwner}"."LongParent" TO dsh_source_owner`);
    await sql(
      `CREATE TABLE dsh_source_owner."LongChild" (id INTEGER PRIMARY KEY,"SourceColumn" INTEGER,CONSTRAINT "${'Fk_' + 'f'.repeat(115)}" FOREIGN KEY("SourceColumn") REFERENCES "${longOwner}"."LongParent"("ParentColumn"))`,
    );
    await sql(`GRANT SELECT ON "${longOwner}"."LongParent" TO dsh_reader`);
    await sql('GRANT SELECT ON dsh_source_owner."LongChild" TO dsh_reader');
  });
}

async function atSourceBoundary<T>(
  mutation: () => Promise<void>,
  action: () => Promise<T>,
): Promise<T> {
  const original = oracledb.getConnection;
  let invoked = false;
  oracledb.getConnection = (async (options: any) => {
    const connection = await (original as any).call(oracledb, options);
    if (options.user !== 'dsh_reader') return connection;
    const execute = connection.execute.bind(connection);
    connection.execute = async (text: string, binds?: string[], options?: unknown) => {
      const response = await execute(text, binds ?? [], options ?? {});
      if (
        !invoked &&
        text.includes('constraint_type IN') &&
        binds?.[0] === 'DSH_SOURCE_OWNER' &&
        binds?.[2] === 'R'
      ) {
        invoked = true;
        await mutation();
      }
      return response;
    };
    return connection;
  }) as typeof oracledb.getConnection;
  try {
    const value = await action();
    assert(invoked, 'source catalog boundary was not exercised');
    return value;
  } finally {
    oracledb.getConnection = original;
  }
}

export async function exerciseOracleMetadata(instance: Instance): Promise<void> {
  if (instance.engine !== 'oracle') return;
  console.log(
    '  oracle: cross-schema FK, read-only snapshot across DDL/revoke, visibility and source cancellation',
  );
  const runner = new QueryRunner(
    { ...config(instance), maxRows: 100 },
    async () => instance.password,
  );
  const inspect = () => runner.inspect(oracleColdInput, instance.signal);
  const rows = (value: Awaited<ReturnType<typeof inspect>>) =>
    value.sections.foreignKeys!.rows.map((r) => [r[1], Number(r[2]), r[3], r[4], r[5], r[6]]);
  const original = [
    ['X', 1, 'DSH_TARGET_OWNER', 'CROSS_PK', 'PARENT', 'A'],
    ['Y', 2, 'DSH_TARGET_OWNER', 'CROSS_PK', 'PARENT', 'B'],
  ];
  try {
    const long = await runner.inspect(oracleLongColdInput, instance.signal);
    assert.deepEqual(
      long.sections.foreignKeys!.rows.map((r) => [r[1], r[3], r[4], r[5], r[6]]),
      [['SourceColumn', longOwner, longConstraint, 'LongParent', 'ParentColumn']],
    );
    assert.deepEqual(rows(await inspect()), original);
    const duringDdl = await atSourceBoundary(async () => {
      await withSql(instance, true, async ({ sql }) => {
        await sql('ALTER TABLE dsh_source_owner.child DROP CONSTRAINT cross_fk');
        await sql(
          'ALTER TABLE dsh_source_owner.child ADD CONSTRAINT cross_fk FOREIGN KEY(y,x) REFERENCES dsh_target_owner.parent(c,d)',
        );
      });
    }, inspect);
    assert.deepEqual(rows(duringDdl), original, 'one section must retain its pre-DDL snapshot');
    const changed = [
      ['Y', 1, 'DSH_TARGET_OWNER', 'ALTERNATE_UK', 'PARENT', 'C'],
      ['X', 2, 'DSH_TARGET_OWNER', 'ALTERNATE_UK', 'PARENT', 'D'],
    ];
    assert.deepEqual(rows(await inspect()), changed, 'fresh request must see committed DDL');
    const duringRevoke = await atSourceBoundary(async () => {
      await withSql(instance, true, async ({ sql }) => {
        await sql('REVOKE SELECT ON dsh_target_owner.parent FROM dsh_reader');
      });
    }, inspect);
    assert.deepEqual(
      rows(duringRevoke),
      changed,
      'one section must not mix metadata visibility snapshots',
    );
    const hidden = await inspect();
    assert.equal(hidden.sections.foreignKeys!.rows.length, 2);
    assert(hidden.sections.foreignKeys!.rows.every((r) => r[5] === null && r[6] === null));
    await withSql(instance, true, async ({ sql }) => {
      await sql('GRANT SELECT ON dsh_target_owner.parent TO dsh_reader');
    });
    const duringSourceRevoke = await atSourceBoundary(async () => {
      await withSql(instance, true, async ({ sql }) => {
        await sql('REVOKE SELECT ON dsh_source_owner.child FROM dsh_reader');
      });
    }, inspect);
    assert.deepEqual(rows(duringSourceRevoke), changed, 'source revoke must not mix snapshots');

    const noSource = await inspect();
    assert(Object.values(noSource.sections).every((section) => section.rows.length === 0));
    const own = await runner.inspect(
      { action: 'describe', name: 'CHILD', refresh: true },
      instance.signal,
    );
    assert(Object.values(own.sections).every((section) => section.rows.length === 0));
  } finally {
    await runner.close();
  }
}

export async function exerciseOracleCancellation(instance: Instance): Promise<void> {
  if (instance.engine !== 'oracle') return;
  console.log(
    '  oracle: server-observed in-flight read cancellation, break, capacity recovery and session-zero',
  );
  // Exactly 10 million synthetic pairs, two small row sources, aggregate output only.
  // No business tables, sleeps, packages, permission changes or unlimited generator.
  const slow =
    'SELECT /* dsh_oracle_cancel */ SUM(a.n*b.n) FROM (SELECT LEVEL n FROM dual CONNECT BY LEVEL<=2000) a CROSS JOIN (SELECT LEVEL n FROM dual CONNECT BY LEVEL<=5000) b';
  const monitor =
    "SELECT COUNT(*) FROM v$session s JOIN v$sql q ON q.sql_id=s.sql_id AND q.child_number=s.sql_child_number WHERE s.username='DSH_READER' AND s.status='ACTIVE' AND q.sql_text LIKE 'SELECT /* dsh_oracle_cancel */%'";
  const original = oracledb.getConnection;
  let breaks = 0;
  oracledb.getConnection = (async (options: any) => {
    const connection = await (original as any).call(oracledb, options);
    if (options.user === 'dsh_reader') {
      const breaking = connection.break.bind(connection);
      connection.break = async () => {
        breaks++;
        return breaking();
      };
    }
    return connection;
  }) as typeof oracledb.getConnection;
  const runner = new QueryRunner(config(instance), async () => instance.password, undefined, {
    maxConcurrent: 1,
  });
  const controller = new AbortController();
  try {
    await withSql(instance, true, async ({ sql }) => {
      await sql(monitor); // Prepare observation only, after cold acceptance, never product metadata.
      let settled = false;
      const pending = runner
        .query(slow, AbortSignal.any([instance.signal, controller.signal]))
        .then(
          (value) => ({ value, error: undefined }),
          (error) => ({ value: undefined, error }),
        )
        .finally(() => {
          settled = true;
        });
      let observed = false;
      try {
        for (let i = 0; i < 40 && !settled; i++) {
          if (Number((await sql(monitor))[0]?.[0]) > 0) {
            observed = true;
            break;
          }
          await delay(25);
        }
        assert(observed, 'bounded Oracle query was not observed active on the server');
        controller.abort();
        const outcome = await pending;
        assert.equal(outcome.error?.code, 'CANCELED');
        assert.equal(breaks, 1);
        assert.equal(
          (await runner.test(instance.signal)).rowCount,
          1,
          'capacity must be reusable after cleanup',
        );
      } finally {
        controller.abort();
        await pending;
        await runner.close();
      }
      let count = -1;
      for (let i = 0; i < 20; i++) {
        count = Number(
          (await sql("SELECT COUNT(*) FROM v$session WHERE username='DSH_READER'"))[0]?.[0],
        );
        if (count === 0) break;
        await delay(50);
      }
      assert.equal(count, 0, 'reader sessions must disappear after in-flight cancellation');
    });
  } finally {
    await runner.close();
    oracledb.getConnection = original;
  }
}
