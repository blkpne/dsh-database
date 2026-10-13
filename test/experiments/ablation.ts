/** Controlled mechanism ablations. No production bypass flags; all DB writes stay in a disposable fixture. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { projectPath, temporaryDirectory } from '../../scripts/paths.mjs';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { ConnectionManager } from '../../src/manager.js';
import { QueryRunner, loadAdapter } from '../../src/query.js';
import type { ConnectionRecord } from '../../src/schema.js';
import { accessPolicy, OwnerBudgets } from '../../src/policy.js';
import { validateReadOnlySql } from '../../src/sql.js';
import { withContainer } from '../docker/lifecycle.js';
import { config, seed, waitReady, withSql } from '../docker/fixtures.js';
import { docker } from '../docker/process.js';

const directory = await temporaryDirectory('ablation-', true);
const source = await readFile(projectPath('src/manager.ts'), 'utf8');
const needle = '.filter(([, probe]) => probe.id === id)';
assert.equal(source.split(needle).length, 2, 'Mutation must target exactly one mechanism');
await build({
  stdin: {
    contents: source.replace(needle, '.filter(() => false)'),
    resolveDir: projectPath('src'),
    loader: 'ts',
  },
  outfile: `${directory}/without-probe-retirement.mjs`,
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
});
const WithoutRetirement = (
  await import(pathToFileURL(`${directory}/without-probe-retirement.mjs`).href)
).ConnectionManager as typeof ConnectionManager;
const lifecycle = [];
for (const [variant, Manager] of [
  ['full', ConnectionManager],
  ['without-probe-retirement', WithoutRetirement],
] as const) {
  for (const action of ['save', 'toggle', 'remove'] as const) {
    const records = new Map<string, ConnectionRecord>();
    let active = 0;
    let entered!: () => void;
    const ready = new Promise<void>((r) => {
      entered = r;
    });
    const manager = new Manager(
      {
        entries: () => records.entries(),
        get: (id) => records.get(id),
        put: async (id, record) => {
          records.set(id, record);
        },
        delete: async (id) => records.delete(id),
      },
      { read: async () => '', set: async () => {}, delete: async () => {} },
      async () => async () => {},
      {},
      (settings, password) =>
        new QueryRunner(settings, password, async () => async (_input, { signal }) => {
          active++;
          entered();
          try {
            await new Promise<void>((r) =>
              signal.addEventListener('abort', () => r(), { once: true }),
            );
          } finally {
            active--;
          }
        }),
    );
    try {
      const input = { name: 'Owned probe', host: 'localhost', user: 'reader' };
      const [saved] = (await manager.save(input)).connections;
      const probe = manager.test(input, saved!.id).catch(() => {});
      await ready;
      const start = performance.now();
      if (action === 'save') await manager.save(input, saved!.id, saved!.revision);
      else if (action === 'toggle') await manager.toggle(saved!.id, false, saved!.revision);
      else await manager.remove(saved!.id, saved!.revision);
      lifecycle.push({
        variant,
        action,
        activeAfterReturn: active,
        durationMs: Math.round(performance.now() - start),
      });
      assert.equal(active, variant === 'full' ? 0 : 1);
      await manager.close();
      await probe;
      assert.equal(active, 0);
    } finally {
      await manager.close();
    }
  }
}
// Same 12 counter requests across three child keys. Only owner-sharing changes.
const budgets = [];
for (const shared of [true, false]) {
  const budget = new OwnerBudgets();
  const policy = accessPolicy.parse({ callsPerMinute: 5 });
  let accepted = 0,
    rejected = 0;
  for (let i = 0; i < 12; i++) {
    try {
      budget.take(shared ? 'connection/parent' : `connection/child-${i % 3}`, policy, 1000);
      accepted++;
    } catch {
      rejected++;
    }
  }
  budgets.push({ sharedOwner: shared, calls: 12, accepted, rejected });
  assert.equal(accepted, shared ? 5 : 12);
}
const endpoint =
  process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT
    ? process.env.DOCKER_HOST
    : await docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
assert.match(endpoint, /^(unix|npipe):\/\//);
process.env.DOCKER_HOST = endpoint;
delete process.env.DOCKER_CONTEXT;
const cache: {
  variant: string;
  calls: number;
  executions: number;
  hits: number;
  durationMs: number;
}[] = [];
const safety: { reader: boolean; readOnly: boolean; expression: string; accepted: boolean }[] = [];
let version = '';
await withContainer(
  'postgresql',
  async (instance) => {
    await waitReady(instance);
    await seed(instance);
    await withSql(instance, true, async ({ sql }) => {
      version = String((await sql('SHOW server_version'))[0]![0]);
      await sql(
        'CREATE TABLE ablation_counter (n integer); INSERT INTO ablation_counter VALUES (0)',
      );
      await sql(
        'CREATE FUNCTION ablation_invoker() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN UPDATE ablation_counter SET n=n+1; RETURN 1; END $$',
      );
      await sql(
        'CREATE FUNCTION ablation_definer() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ BEGIN UPDATE ablation_counter SET n=n+1; RETURN 1; END $$',
      );
    });
    // Same query text and fixture; only account privilege and transaction read-only are removed.
    for (const reader of [true, false])
      for (const readOnly of [true, false]) {
        for (const expression of ['ablation_invoker()', 'ablation_definer()']) {
          const text = `SELECT ${expression}`;
          validateReadOnlySql(text, 'postgresql');
          let accepted = false;
          await withSql(instance, !reader, async ({ sql }) => {
            await sql(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
            try {
              await sql(text);
              accepted = true;
            } catch {
              /* SQLSTATE is intentionally excluded from data, only outcome matters here. */
            } finally {
              await sql('ROLLBACK');
            }
          });
          safety.push({ reader, readOnly, expression, accepted });
          assert.equal(accepted, !readOnly && (!reader || expression === 'ablation_definer()'));
        }
      }
    for (const refresh of [false, true]) {
      let executions = 0;
      const runner = new QueryRunner(
        config(instance),
        async () => instance.password,
        async (engine) => {
          const adapter = await loadAdapter(engine);
          return async (...args) => {
            executions++;
            return adapter(...args);
          };
        },
      );
      const start = performance.now();
      let hits = 0;
      try {
        for (let i = 0; i < 12; i++) {
          const result = await runner.inspect(
            { action: 'search', name: 'dsh_test_items', refresh },
            undefined,
            'same-owner',
          );
          assert.equal(result.sections.objects?.rows.length, 1);
          if (result.cache.hit) hits++;
        }
        cache.push({
          variant: refresh ? 'forced-refresh' : 'full',
          calls: 12,
          executions,
          hits,
          durationMs: Math.round(performance.now() - start),
        });
        assert.equal(executions, refresh ? 12 : 1);
      } finally {
        await runner.close();
      }
    }
  },
  { timeoutMs: 180000 },
);
const report = {
  time: new Date().toISOString(),
  node: process.version,
  postgres: version,
  managerSourceSha256: createHash('sha256').update(source).digest('hex'),
  lifecycle,
  budgets,
  cache,
  safety,
  limitations: [
    'Lifecycle uses the real QueryRunner with a controlled abort-aware adapter, not a DB server.',
    'Budget owner ablation tests the counter primitive; trusted ancestry mapping is covered by separate real Cordis tests.',
    'Cache compares identical metadata searches on one local PostgreSQL server; times are not production throughput.',
    'Read-only safety is PostgreSQL-only and does not sandbox arbitrary functions or external effects. All attempted writes are rolled back.',
    'No real model or user-study ablation.',
  ],
};
await writeFile(`${directory}/results.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
console.log(`Report: ${directory}/results.json`);
