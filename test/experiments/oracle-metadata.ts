// Fixed fixture, same account/results/budget. Only catalog SQL shape changes.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { temporaryDirectory } from '../../scripts/paths.mjs';
import { metadataStatements } from '../../src/metadata-sql.js';
import { inspectInput } from '../../src/inspect.js';
import { loadAdapter } from '../../src/query.js';
import { ResultCollector } from '../../src/result.js';
import { withContainer } from '../docker/lifecycle.js';
import { config, waitReady, seed, withSql } from '../docker/fixtures.js';
import { docker } from '../docker/process.js';
const endpoint =
  process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT
    ? process.env.DOCKER_HOST
    : await docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
assert.match(endpoint, /^(unix|npipe):\/\//);
process.env.DOCKER_HOST = endpoint;
delete process.env.DOCKER_CONTEXT;
const directory = await temporaryDirectory('oracle-metadata-');
console.log(`Report directory: ${directory}`);
const measurements: unknown[] = [];
try {
  await withContainer('oracle', async (instance) => {
    await waitReady(instance);
    await seed(instance);
    await withSql(instance, true, async ({ sql }) => {
      await sql(
        'CREATE TABLE SYSTEM.dsh_exp_parent (a INTEGER,b INTEGER,CONSTRAINT dsh_exp_pk PRIMARY KEY(a,b))',
      );
      await sql(
        'CREATE TABLE SYSTEM.dsh_exp_child (id INTEGER PRIMARY KEY,a INTEGER,b INTEGER,CONSTRAINT dsh_exp_fk FOREIGN KEY(a,b) REFERENCES SYSTEM.dsh_exp_parent(a,b))',
      );
      await sql('CREATE TABLE SYSTEM.dsh_exp_hidden (id INTEGER PRIMARY KEY)');
      await sql('GRANT SELECT ON SYSTEM.dsh_exp_parent TO dsh_reader');
      await sql('GRANT SELECT ON SYSTEM.dsh_exp_child TO dsh_reader');
    });
    const settings = { ...config(instance), timeoutMs: 60000 };
    const adapter = await loadAdapter('oracle');
    const expected = new Map<string, unknown>();
    for (let round = 0; round < 2; round++) {
      const order =
        round === 0
          ? ['no_transform', 'baseline', 'predicates', 'no_merge', 'both']
          : ['both', 'no_merge', 'predicates', 'baseline', 'no_transform'];
      for (const variant of order)
        for (const name of ['DSH_TEST_ITEMS', 'DSH_EXP_CHILD', 'DSH_EXP_HIDDEN']) {
          const statements = metadataStatements(
            settings,
            inspectInput.parse({ action: 'describe', schema: 'SYSTEM', name }),
          );
          for (const { section, statement } of statements.filter((s) =>
            ['keys', 'foreignKeys'].includes(s.section),
          )) {
            const query = structuredClone(statement!);
            assert(query.text.startsWith('SELECT /*+ NO_QUERY_TRANSFORMATION */'));
            query.text = query.text.replace('/*+ NO_QUERY_TRANSFORMATION */ ', '');
            if (variant === 'no_transform')
              query.text = query.text.replace('SELECT ', 'SELECT /*+ NO_QUERY_TRANSFORMATION */ ');
            if (variant === 'no_merge' || variant === 'both')
              query.text = query.text.replace(
                'SELECT ',
                `SELECT /*+ NO_MERGE(c) NO_MERGE(col)${section === 'foreignKeys' ? ' NO_MERGE(r) NO_MERGE(rc)' : ''} */ `,
              );
            if (variant === 'predicates' || variant === 'both') {
              query.text = query.text.replace(
                ' ORDER BY',
                ' AND col.owner=COALESCE(:3,USER) AND col.table_name=:4 ORDER BY',
              );
              query.values.push('SYSTEM', name);
            }
            query.text += ` /* dsh_catalog_comparison_round_${round} */`;
            const result = new ResultCollector(500);
            const started = performance.now();
            await adapter(query, {
              config: settings,
              password: instance.password,
              signal: AbortSignal.any([instance.signal, AbortSignal.timeout(60000)]),
              result,
            });
            const value = result.finish();
            const key = name + '/' + section;
            if (!expected.has(key)) expected.set(key, value.rows);
            else assert.deepEqual(value.rows, expected.get(key));
            if (name === 'DSH_EXP_HIDDEN') assert.equal(value.rows.length, 0);
            if (name === 'DSH_EXP_CHILD' && section === 'foreignKeys') {
              assert.equal(value.rows.length, 2);
              assert.equal(value.rows[0]?.[5], 'DSH_EXP_PARENT');
              assert.equal(value.rows[0]?.[6], 'A');
              assert.equal(value.rows[1]?.[6], 'B');
            }
            const row = {
              round,
              variant,
              name,
              section,
              durationMs: Math.round(performance.now() - started),
              rows: value.rows.length,
            };
            measurements.push(row);
            console.log(JSON.stringify(row));
          }
        }
    }
  });
} finally {
  await writeFile(
    `${directory}/oracle-query-comparison.json`,
    JSON.stringify(
      {
        time: new Date().toISOString(),
        node: process.version,
        diagnosticBudgetMs: 60000,
        limitations: [
          'Same disposable Oracle instance; reverse-order second round reduces but does not eliminate cache/order effects.',
          'Timings are local observations, not latency guarantees; cold acceptance uses separate instances and the unchanged 10 s budget.',
        ],
        measurements,
      },
      null,
      2,
    ) + '\n',
  );
}
