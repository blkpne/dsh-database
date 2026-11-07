/**
 * Deterministic installed-release + real PostgreSQL first-use regression.
 * No browser, AgentLoop, model provider or model API call is exercised.
 *
 * node test/first-use-smoke.mjs --installation /isolated/installed-root
 * DSH_DATABASE_FIRST_USE_FIXTURE: path to a JSON file {host,port,user,password,database,tls}
 * Or DSH_DATABASE_FIRST_USE_PG_{HOST,PORT,USER,PASSWORD,DATABASE,TLS}.
 * Requires the existing test/docker/fixtures.ts PostgreSQL synthetic fixture.
 * This runner never seeds databases. Only loopback dsh_test/dsh_reader is accepted.
 * DSH_DATABASE_TEST_ROOT optionally selects the temporary state directory parent.
 * DSH_DATABASE_FIRST_USE_REPORT optionally selects a sanitized JSON report file.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const report = {
  kind: 'deterministic-installed-host-postgresql',
  modelInvoked: false,
  browserTested: false,
  checks: [],
};
let step = 'configuration';
let state;
let close = async () => {};
const mark = (name) => report.checks.push(name);
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(
      'Usage: node test/first-use-smoke.mjs --installation /isolated/installed-root\nSet DSH_DATABASE_FIRST_USE_FIXTURE to a synthetic PostgreSQL fixture JSON file path. No models invoked.',
    );
    return;
  }
  assert(args.length === 2 && args[0] === '--installation', 'Explicit installation required');
  const installation = await realpath(resolve(args[1]));
  const require = createRequire(join(installation, 'package.json'));
  const load = async (name) => {
    report.lastLoadedModule = name;
    try {
      return await import(pathToFileURL(require.resolve(name)).href);
    } catch (error) {
      if (['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'].includes(error?.code))
        report.missingModule = name;
      throw error;
    }
  };
  const pluginPath = await realpath(require.resolve('dsh-database'));
  const installedRelativePath = relative(join(installation, 'node_modules'), pluginPath);
  assert(
    installedRelativePath &&
      !isAbsolute(installedRelativePath) &&
      installedRelativePath !== '..' &&
      !installedRelativePath.startsWith(`..${sep}`),
    'Plugin must be installed inside the isolated installation',
  );
  const raw = process.env.DSH_DATABASE_FIRST_USE_FIXTURE
    ? JSON.parse(await readFile(process.env.DSH_DATABASE_FIRST_USE_FIXTURE, 'utf8'))
    : Object.fromEntries(
        ['host', 'port', 'user', 'password', 'database', 'tls'].map((key) => [
          key,
          process.env[`DSH_DATABASE_FIRST_USE_PG_${key.toUpperCase()}`],
        ]),
      );
  assert(['127.0.0.1', 'localhost', '::1'].includes(raw.host));
  assert.equal(raw.database, 'dsh_test');
  assert.equal(raw.user, 'dsh_reader');
  assert(typeof raw.password === 'string' && raw.password.length > 0);
  assert([true, false, 'true', 'false'].includes(raw.tls));
  assert(Number.isInteger(Number(raw.port)) && Number(raw.port) > 0 && Number(raw.port) <= 65535);
  const connection = {
    name: 'Isolated first-use PostgreSQL',
    engine: 'postgresql',
    host: raw.host,
    port: Number(raw.port),
    user: raw.user,
    password: raw.password,
    database: raw.database,
    tls: raw.tls === true || raw.tls === 'true',
    timeoutMs: 10000,
    maxRows: 100,
    policy: { access: 'sessions', mode: 'query', sessionIds: ['first-use-owner'] },
  };
  report.pluginVersion = require('dsh-database/package.json').version;
  report.hostVersion = require('@deepseek-ai/dsh/package.json').version;
  const { Context } = await load('@deepseek-ai/cordis');
  const { createScope } = await load('@deepseek-ai/dsh-scope');
  const ToolRuntime = (await load('@deepseek-ai/dsh-tools')).default;
  const Database = await load('dsh-database');
  const root = resolve(process.env.DSH_DATABASE_TEST_ROOT ?? tmpdir());
  await mkdir(root, { recursive: true });
  state = await mkdtemp(join(root, 'dsh-first-use-'));
  const boot = async () => {
    const ctx = new Context();
    const fibers = [];
    const owned = [];
    const mount = async (plugin, config) => {
      const fiber = ctx.plugin(plugin, config);
      fibers.push(fiber);
      await fiber.await();
      return fiber;
    };
    close = async () => {
      const failures = [];
      for (const dispose of [...owned].reverse()) {
        try {
          await dispose();
        } catch {
          failures.push('scope');
        }
      }
      for (const fiber of [...fibers].reverse()) {
        try {
          await fiber.dispose();
        } catch {
          failures.push('provider');
        }
      }
      assert.equal(failures.length, 0, 'Host cleanup failed');
    };
    await mount((await load('@deepseek-ai/dsh-system-prompt')).default, {});
    const batch = typeof ToolRuntime.prototype.setExecutor === 'function';
    await mount(ToolRuntime, batch ? {} : { mode: 'native' });
    if (batch) await mount(await load('@deepseek-ai/dsh-tool-executor-native'));
    await mount((await load('@deepseek-ai/dsh-storage')).default);
    await mount(await load('@deepseek-ai/dsh-storage-json'), { root: join(state, 'storage') });
    await mount(await load('@deepseek-ai/dsh-storage-domain'), { backend: 'json' });
    await mount((await load('@deepseek-ai/dsh-credentials-local')).default, {
      path: join(state, 'credentials.yaml'),
      watch: false,
    });
    await mount(await load('@deepseek-ai/dsh-client-connection'), {});
    // Current hosts require projections before the Agent registry becomes available.
    await mount((await load('@deepseek-ai/dsh-session-projection')).default);
    step = 'host-bootstrap-agent-registry';
    await mount((await load('@deepseek-ai/dsh-agent')).default);
    const agent = async (id) => {
      // Synthetic identity registered through the real public Host registry, not an AgentLoop.
      const value = { id, session: { id, header: { cwd: state } } };
      const scope = createScope(ctx, value);
      value.ctx = scope.ctx;
      const unregister = ctx.agents.register(value);
      owned.push(async () => {
        await unregister();
        await scope.dispose();
      });
      await unregister;
      return value;
    };
    step = 'host-bootstrap-session-scopes';
    const owner = await agent('first-use-owner');
    const stranger = await agent('first-use-stranger');
    step = 'host-bootstrap-database';
    const plugin = await mount(Database, { namespace: 'first_use' });
    const api = async (body, expectedStatus = 200) => {
      const response = await ctx.connection.createSharedFetchHandler('/api').fetch(
        new Request('http://127.0.0.1/api/dsh-database', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        ctx.connection.browserPeer,
      );
      assert.equal(response.status, expectedStatus);
      const data = await response.json();
      assert(!JSON.stringify(data).includes(raw.password), 'API exposed password');
      return data;
    };
    let counter = 0;
    const call = async (
      agent,
      name,
      args,
      signal = new AbortController().signal,
      callId = `first-use-${++counter}`,
    ) => {
      const output = batch
        ? (
            await ctx.tools.execute({
              agent,
              calls: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) }],
              signal,
            })
          ).results[0].result
        : await ctx.tools.execute({ agent, name, callId, arguments: args, signal });
      assert(!JSON.stringify(output).includes(raw.password), 'Tool exposed password');
      return output;
    };
    return { ctx, owner, stranger, api, call, plugin };
  };
  const value = (result) => {
    assert.equal(result.isError, false);
    // The current Host renders canonical JSON into content; do not depend on private value fields.
    return JSON.parse(result.content.find((part) => part.type === 'text').text);
  };
  step = 'host-bootstrap';
  let app = await boot();
  step = 'test-connection';
  assert.equal((await app.api({ action: 'test', connection })).ok, true);
  assert.equal((await app.api({ action: 'list' })).connections.length, 0);
  mark(step);
  step = 'wrong-password';
  const bad = await app.api(
    { action: 'test', connection: { ...connection, password: `wrong-${raw.password}` } },
    400,
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.code, '28P01');
  mark(step);
  step = 'save-disabled';
  let record = (await app.api({ action: 'save', connection })).connections[0];
  assert.equal(record.enabled, false);
  assert.equal(app.ctx.tools.schemas(app.owner).length, 0);
  assert(
    !(await readFile(join(state, 'storage/dsh_database_first_use.json'), 'utf8')).includes(
      raw.password,
    ),
  );
  mark(step);
  const toggle = async (enabled) => {
    record = (
      await app.api({ action: 'toggle', id: record.id, revision: record.revision, enabled })
    ).connections[0];
    assert.equal(record.enabled, enabled);
  };
  await toggle(true);
  step = 'session-authorization';
  assert.equal(app.ctx.tools.schemas(app.owner).length, 2);
  assert.equal(app.ctx.tools.schemas(app.stranger).length, 0);
  assert.equal(app.ctx.tools.schemas().length, 0);
  assert.equal((await app.call(app.stranger, record.toolName, { sql: 'SELECT 1' })).isError, true);
  const forged = { ...app.owner };
  assert.equal((await app.call(forged, record.toolName, { sql: 'SELECT 1' })).isError, true);
  value(await app.call(app.owner, record.inspectToolName, { action: 'capabilities' }));
  mark(step);
  step = 'inspect-and-aggregate';
  const described = value(
    await app.call(app.owner, record.inspectToolName, {
      action: 'describe',
      schema: 'public',
      name: 'dsh_test_items',
    }),
  );
  assert(JSON.stringify(described).includes('category'));
  const aggregate = async () => {
    const result = value(
      await app.call(app.owner, record.toolName, {
        sql: 'SELECT category, SUM(amount) AS total FROM dsh_test_items GROUP BY category ORDER BY category',
      }),
    );
    assert.deepEqual(
      result.rows.map(([category, total]) => [category, Number(total)]),
      [
        ['A', 30.375],
        ['B', 5],
      ],
    );
    assert.equal(result.readOnly, true);
  };
  await aggregate();
  mark(step);
  step = 'read-only-denial';
  const denied = await app.call(app.owner, record.toolName, { sql: 'DELETE FROM dsh_test_items' });
  assert.equal(denied.isError, true);
  assert(JSON.stringify(denied).includes('READ_ONLY_VIOLATION'));
  mark(step);
  step = 'cancel-and-recover';
  const controller = new AbortController();
  const callId = 'first-use-cancel';
  const pending = app.call(
    app.owner,
    record.toolName,
    { sql: 'SELECT SUM(n) FROM generate_series(1, 100000000) AS sample(n)' },
    controller.signal,
    callId,
  );
  let executing = false;
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const snapshot = (await app.api({ action: 'observations', id: record.id })).observations;
      executing = snapshot.records.some(
        (trace) =>
          trace.callId === callId &&
          trace.outcome === 'running' &&
          trace.stages.some((stage) => stage.name === 'execute'),
      );
      if (executing) break;
      await delay(20);
    }
  } finally {
    controller.abort();
  }
  const canceled = await pending;
  assert(executing, 'Cancellation must reach actual driver execution');
  assert.equal(canceled.isError, true);
  // The Host can return cancellation before the driver's asynchronous close settles.
  const cleanupStarted = Date.now();
  let trace;
  do {
    trace = (await app.api({ action: 'observations', id: record.id })).observations.records.find(
      (item) => item.callId === callId,
    );
    if (trace?.driverClosed && trace.finalHostOutcome) break;
    await delay(20);
  } while (Date.now() - cleanupStarted < 5000);
  report.cancellation = {
    code: trace?.code,
    cancelRequested: trace?.cancelRequested,
    driverClosed: trace?.driverClosed,
    finalHostOutcome: trace?.finalHostOutcome,
    serverTermination: trace?.serverTermination,
    cleanupWaitMs: Date.now() - cleanupStarted,
  };
  assert.equal(trace?.cancelRequested, true);
  assert.equal(trace?.driverClosed, true);
  assert.equal(trace?.finalHostOutcome, true);
  await aggregate();
  mark(step);
  step = 'disable-and-revoke';
  await toggle(false);
  assert.equal(app.ctx.tools.schemas(app.owner).length, 0);
  assert.equal((await app.call(app.owner, record.toolName, { sql: 'SELECT 1' })).isError, true);
  await toggle(true);
  mark(step);
  step = 'full-host-restart-persistence';
  const savedId = record.id;
  const savedRevision = record.revision;
  await close();
  close = async () => {};
  app = await boot();
  step = 'full-host-restart-persistence';
  record = (await app.api({ action: 'list' })).connections[0];
  assert.equal(record.id, savedId);
  assert.equal(record.revision, savedRevision);
  assert.equal(record.hasPassword, true);
  assert.equal(record.status, 'enabled');
  assert.equal(app.ctx.tools.schemas(app.stranger).length, 0);
  await aggregate();
  mark(step);
  step = 'unload-revokes-tools';
  await app.plugin.dispose();
  assert.equal(app.ctx.tools.schemas(app.owner).length, 0);
  mark(step);
  report.passed = true;
}
try {
  await main();
} catch (error) {
  report.failureType = error instanceof Error ? error.name : 'UnknownError';
  const location = /first-use-smoke\.mjs:(\d+):(\d+)/.exec(String(error?.stack ?? ''));
  if (location) report.failureLocation = `test/first-use-smoke.mjs:${location[1]}:${location[2]}`;
  // Do not print assertions, raw driver errors, configuration, SQL or credentials.
  report.passed = false;
  report.failedStep = step;
  process.exitCode = 1;
} finally {
  try {
    await close();
  } catch {
    report.passed = false;
    report.cleanupFailed = true;
    process.exitCode = 1;
  }
  if (state) await rm(state, { recursive: true, force: true });
  if (process.env.DSH_DATABASE_FIRST_USE_REPORT) {
    const path = resolve(process.env.DSH_DATABASE_FIRST_USE_REPORT);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(report, null, 2) + '\n');
  }
  if (!process.argv.includes('--help')) console.log(JSON.stringify(report, null, 2));
}
