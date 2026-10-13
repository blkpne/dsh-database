import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Agents from '@deepseek-ai/dsh-agent';
import type { Agent } from '@deepseek-ai/dsh-agent';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { createScope } from '@deepseek-ai/dsh-scope';
import { SessionId } from '@deepseek-ai/dsh-session';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { harness } from './harness.js';
import { accessPolicy, OwnerBudgets } from '../src/policy.js';
import { Inspector } from '../src/inspect.js';
import { connectionInput, DatabaseError } from '../src/schema.js';
import { Observatory, traceRecord } from '../src/observability.js';
import { connectDatabaseMcp } from '../src/mcp.js';
import { QueryRunner } from '../src/query.js';
import { createServer } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';

const settings = connectionInput.parse({
  name: 'Catalog fixture',
  host: 'localhost',
  user: 'reader',
  engine: 'postgresql',
  database: 'fixture',
});
const result = (value: string) => ({
  columns: ['name'],
  rows: [[value]],
  rowCount: 1,
  truncated: false,
  durationMs: 1,
  readOnly: true as const,
});

test('actual Node process PTC returns canonical inspect data and shares limits with native calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-connector-ptc-'));
  const app = await harness(directory, 'both');
  try {
    let response = await app.api({
      action: 'save',
      connection: {
        ...settings,
        policy: accessPolicy.parse({ mode: 'metadata', callsPerMinute: 1, callsPerHour: 1 }),
      },
    });
    let record = response.connections[0];
    response = await app.api({
      action: 'toggle',
      id: record.id,
      revision: record.revision,
      enabled: true,
    });
    record = response.connections[0];
    const ptc = await app.ctx.tools.execute({
      name: 'run_code',
      callId: ToolCallId('ptc-parent'),
      arguments: {
        code: `return await tools.${record.inspectToolName}({ action: 'capabilities' });`,
        description: 'Inspect connection capabilities',
      },
      signal: new AbortController().signal,
    });
    assert.equal(ptc.isError, false, JSON.stringify(ptc));
    assert(JSON.stringify(ptc).includes('PostgreSQL'));
    const native = await app.ctx.tools.execute({
      name: record.inspectToolName,
      callId: ToolCallId('native-after-ptc'),
      arguments: { action: 'capabilities' },
      signal: new AbortController().signal,
    });
    assert.equal(native.isError, true);
    assert(JSON.stringify(native).includes('RATE_LIMITED'));
    const snapshot = (await app.api({ action: 'observations', id: record.id })).observations;
    const child = snapshot.records.find((r: any) => r.rootCallId === 'ptc-parent');
    assert(child);
    assert.equal(child.finalHostOutcome, true);
    assert.notEqual(child.callId, child.rootCallId);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('scope authorization hides tools, denies direct calls, inherits real parent scope and shares owner quota', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-connector-policy-'));
  const app = await harness(directory);
  const agents = app.ctx.plugin(Agents);
  await agents.await();
  const owned: { dispose(): Promise<void> }[] = [];
  const add = (id: string, parent?: Agent) => {
    // Actual public Scope + AgentRegistry; no model loop is claimed by this test.
    const agent = { id: SessionId(id), session: { id: SessionId(id) } } as Agent;
    const scope = createScope(app.ctx, agent, parent ? { parent } : undefined);
    Object.assign(agent, { ctx: scope.ctx });
    const unregister = app.ctx.agents.register(agent);
    owned.push({
      async dispose() {
        await unregister();
        await scope.dispose();
      },
    });
    return agent;
  };
  try {
    const owner = add('owner-a');
    const stranger = add('owner-b');
    let response = await app.api({
      action: 'save',
      connection: {
        ...settings,
        policy: accessPolicy.parse({
          access: 'sessions',
          sessionIds: ['owner-a'],
          mode: 'metadata',
          callsPerMinute: 2,
          callsPerHour: 2,
        }),
      },
    });
    let record = response.connections[0];
    response = await app.api({
      action: 'toggle',
      id: record.id,
      revision: record.revision,
      enabled: true,
    });
    record = response.connections[0];
    assert.equal(record.status, 'enabled');
    assert.equal(app.ctx.tools.schemas().length, 0);
    assert.equal(app.ctx.tools.schemas(stranger).length, 0);
    assert.deepEqual(
      app.ctx.tools.schemas(owner).map((t) => t.name),
      [record.inspectToolName],
    );
    const child = add('child-a', owner);
    assert.deepEqual(
      app.ctx.tools.schemas(child).map((t) => t.name),
      [record.inspectToolName],
    );
    let n = 0;
    const call = (
      agent: Agent,
      name = record.inspectToolName,
      args: unknown = { action: 'capabilities' },
    ) =>
      app.ctx.tools.execute({
        agent,
        callId: ToolCallId(`policy-${++n}`),
        name,
        arguments: args,
        signal: new AbortController().signal,
      });
    assert((await call(stranger)).isError);
    assert((await call(owner, record.toolName, { sql: 'SELECT 1' })).isError);
    const first = await call(owner);
    assert.equal(first.isError, false, JSON.stringify(first));
    const second = await call(child);
    assert.equal(second.isError, false, JSON.stringify(second));
    const limited = await call(child);
    assert.equal(limited.isError, true);
    assert(JSON.stringify(limited).includes('RATE_LIMITED'));
    const snapshot = (await app.api({ action: 'observations', id: record.id })).observations;
    assert.equal(snapshot.records.length, 5);
    assert.equal(snapshot.records.filter((r: any) => r.outcome === 'success').length, 2);
    assert(snapshot.records.every((r: any) => r.finalHostOutcome));
    assert(
      snapshot.records.some(
        (r: any) => r.agentId === 'child-a' && r.ownerId === 'owner-a' && r.cacheHit,
      ),
    );
    // Legacy clients updating connection settings cannot drop the saved policy.
    response = await app.api({
      action: 'save',
      id: record.id,
      revision: record.revision,
      connection: settings,
    });
    record = response.connections[0];
    assert.equal(record.policy.access, 'sessions');
    assert((await call(owner)).isError, 'a policy/config revision must not reset quotas');
    await app.api({ action: 'toggle', id: record.id, revision: record.revision, enabled: false });
    assert.equal(app.ctx.tools.schemas(child).length, 0);
    assert((await call(owner)).isError);
  } finally {
    for (const scope of owned.reverse()) await scope.dispose();
    await agents.dispose();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('partial scoped mounting rolls back every registered tool before reporting failure', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-connector-mount-failure-'));
  const app = await harness(directory);
  const registry = app.ctx.plugin(Agents);
  await registry.await();
  const owners = ['first-owner', 'second-owner'].map((id) => {
    const agent = { id: SessionId(id), session: { id: SessionId(id) } } as Agent;
    const scope = createScope(app.ctx, agent);
    Object.assign(agent, { ctx: scope.ctx });
    return { agent, scope, unregister: app.ctx.agents.register(agent) };
  });
  const original = ToolRuntime.prototype.register;
  let registrations = 0;
  const mock = t.mock.method(
    ToolRuntime.prototype,
    'register',
    function (this: ToolRuntime, definition: Parameters<ToolRuntime['register']>[0]) {
      if (++registrations === 4) throw new Error('injected second owner registration failure');
      return original.call(this, definition);
    },
  );
  try {
    const saved = await app.api({
      action: 'save',
      connection: {
        ...settings,
        policy: accessPolicy.parse({
          access: 'sessions',
          sessionIds: owners.map(({ agent }) => agent.id),
        }),
      },
    });
    const record = saved.connections[0];
    const response = await app.api({
      action: 'toggle',
      id: record.id,
      revision: record.revision,
      enabled: true,
    });
    assert.equal(registrations, 4);
    assert.equal(response.connections[0].status, 'error');
    for (const { agent } of owners) assert.deepEqual(app.ctx.tools.schemas(agent), []);
  } finally {
    mock.mock.restore();
    for (const owner of owners.reverse()) {
      await owner.unregister();
      await owner.scope.dispose();
    }
    await registry.dispose();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('scope-required connection fails closed when the host has no AgentRegistry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-connector-no-scope-'));
  const app = await harness(directory);
  try {
    const saved = await app.api({
      action: 'save',
      connection: {
        ...settings,
        policy: accessPolicy.parse({ access: 'sessions', sessionIds: ['absent'] }),
      },
    });
    const record = saved.connections[0];
    const response = await app.api({
      action: 'toggle',
      id: record.id,
      revision: record.revision,
      enabled: true,
    });
    assert.equal(response.connections[0].status, 'error');
    assert.equal(app.ctx.tools.schemas().length, 0);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('metadata cache isolates scopes, refresh races cannot restore stale entries, and clear invalidates pending reads', async () => {
  let resolve!: (value: ReturnType<typeof result>) => void;
  let calls = 0;
  const inspector = new Inspector(settings, async () => {
    calls++;
    if (calls === 1)
      return new Promise((r) => {
        resolve = r;
      });
    return result('new');
  });
  const old = inspector.inspect({ action: 'search' }, undefined, 'a');
  await inspector.inspect({ action: 'search', refresh: true }, undefined, 'a');
  resolve(result('old'));
  await old;
  const cached = await inspector.inspect({ action: 'search' }, undefined, 'a');
  assert.equal(cached.cache.hit, true);
  assert.equal(cached.sections.objects?.rows[0]?.[0], 'new');
  assert.equal((await inspector.inspect({ action: 'search' }, undefined, 'b')).cache.hit, false);
  inspector.clear();
  assert.equal((await inspector.inspect({ action: 'search' }, undefined, 'a')).cache.hit, false);
});

test('metadata reads bind hostile names, avoid query-policy bypass, and distinguish permission denial from empty', async () => {
  const requests: unknown[] = [];
  const inspector = new Inspector(settings, async (request) => {
    requests.push(request);
    throw new DatabaseError('42501', 'denied');
  });
  const description = await inspector.inspect({
    action: 'describe',
    name: "x' UNION SELECT password",
  });
  assert(Object.values(description.sections).every((section) => section.status === 'denied'));
  for (const request of requests as { text: string; values: string[] }[]) {
    assert(!request.text.includes('UNION SELECT password'));
    assert(request.values.includes("x' UNION SELECT password"));
  }
  let driverCalled = false;
  const runner = new QueryRunner(
    { ...settings, policy: accessPolicy.parse({ mode: 'metadata' }) },
    async () => '',
    async () => async () => {
      driverCalled = true;
    },
  );
  await assert.rejects(runner.query('SELECT 1'), { code: 'POLICY_DENIED' });
  await assert.rejects(runner.mongo({ operation: 'find', collection: 'x' }), {
    code: 'POLICY_DENIED',
  });
  assert.equal(driverCalled, false);
  await runner.close();
});

test('standalone MCP metadata mode omits query and applies the trusted transport gate to inspect', async () => {
  let allowed = false;
  const inspector = new Inspector(settings, async () => result('unused'));
  const mcp = await connectDatabaseMcp('standalone', async () => result('unused'), undefined, {
    metadataOnly: true,
    inspect: (input, signal) => inspector.inspect(input, signal),
    authorize() {
      if (!allowed) throw new DatabaseError('POLICY_DENIED', 'transport owner required');
    },
  });
  try {
    assert.deepEqual(
      (await mcp.client.listTools()).tools.map((t) => t.name),
      ['inspect'],
    );
    assert.equal(
      (await mcp.client.callTool({ name: 'inspect', arguments: { action: 'capabilities' } }))
        .isError,
      true,
    );
    allowed = true;
    const response = await mcp.client.callTool({
      name: 'inspect',
      arguments: { action: 'capabilities' },
    });
    assert.equal(response.isError, undefined);
    assert.equal(
      (
        await mcp.client.callTool({
          name: 'inspect',
          arguments: { action: 'capabilities', ownerId: 'forged' },
        })
      ).isError,
      true,
    );
    assert.equal(
      (await mcp.client.callTool({ name: 'query', arguments: { sql: 'SELECT 1' } })).isError,
      true,
    );
  } finally {
    await mcp.close();
  }
});

test('owner budgets retain hourly quota across minute rollover and isolate independent owners', () => {
  const budgets = new OwnerBudgets();
  const policy = accessPolicy.parse({ callsPerMinute: 1, callsPerHour: 2 });
  budgets.take('a', policy, 0);
  assert.throws(() => budgets.take('a', policy, 1), { code: 'RATE_LIMITED' });
  budgets.take('b', policy, 1);
  budgets.take('a', policy, 60001);
  assert.throws(() => budgets.take('a', policy, 120001), { code: 'RATE_LIMITED' });
  budgets.take('a', policy, 3600001);
});

test('operational journal bounds memory, queue and storage; interrupted recovery never records business data', async () => {
  const map = new Map<string, ReturnType<typeof traceRecord.parse>>();
  let writes = 0;
  const journal = new Observatory({
    entries: () => map.entries(),
    put: async (id, value) => {
      writes++;
      map.set(id, value);
    },
    delete: async (id) => map.delete(id),
  });
  for (let i = 0; i < 2200; i++) {
    const trace = journal.start({ connectionId: 'test', revision: 1, operation: 'inspect' });
    journal.finish(trace);
  }
  const snapshot = journal.snapshot('test');
  assert.equal(snapshot.records.length, 50);
  assert(journal.dropped > 0);
  await journal.close();
  assert(map.size <= 2000);
  assert(writes <= 128);
  const incomplete = traceRecord.parse({
    ...snapshot.records[0]!,
    requestId: 'crash',
    outcome: 'running',
  });
  map.clear();
  map.set('crash', incomplete);
  const restored = new Observatory({
    entries: () => map.entries(),
    put: async () => {},
    delete: async () => false,
  });
  assert.equal(restored.snapshot('test').records[0]?.outcome, 'interrupted');
  await restored.close();
  assert(!JSON.stringify(snapshot).includes('sql'));
});

test('policy tightening cancels an in-flight real driver call, keeps final Host correlation and survives reload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-connector-revoke-'));
  const app = await harness(directory);
  const sockets = new Set<Socket>();
  let accepted!: () => void;
  const connected = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.resume();
    accepted();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  let next: Awaited<ReturnType<typeof app.mount>> | undefined;
  try {
    let response = await app.api({
      action: 'save',
      connection: {
        ...settings,
        host: '127.0.0.1',
        port: (server.address() as AddressInfo).port,
        timeoutMs: 5000,
      },
    });
    let record = response.connections[0];
    response = await app.api({
      action: 'toggle',
      id: record.id,
      revision: record.revision,
      enabled: true,
    });
    record = response.connections[0];
    const pending = app.ctx.tools.execute({
      name: record.toolName,
      callId: ToolCallId('revoked-call'),
      arguments: { sql: 'SELECT 1' },
      signal: new AbortController().signal,
    });
    await connected;
    response = await app.api({
      action: 'save',
      id: record.id,
      revision: record.revision,
      connection: { ...settings, policy: accessPolicy.parse({ mode: 'metadata' }) },
    });
    assert((await pending).isError);
    assert.deepEqual(
      app.ctx.tools.schemas().map((tool) => tool.name),
      [record.inspectToolName],
    );
    const snapshot = (await app.api({ action: 'observations', id: record.id })).observations;
    const trace = snapshot.records.find((value: any) => value.callId === 'revoked-call');
    assert(trace?.finalHostOutcome);
    assert.equal(trace.revision, record.revision);
    assert.notEqual(trace.outcome, 'success');
    assert.equal(trace.cancelRequested, true);
    assert.equal(trace.outcome, 'canceled');
    assert.equal(snapshot.active, 0);
    await app.plugin.dispose();
    next = await app.mount();
    const restored = (await app.api({ action: 'observations', id: record.id })).observations;
    assert(
      restored.records.some(
        (value: any) => value.requestId === trace.requestId && value.finalHostOutcome,
      ),
    );
    assert.equal((await app.api({ action: 'list' })).connections[0].policy.mode, 'metadata');
  } finally {
    await next?.dispose();
    await app.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('metadata uses its own bounded row budget, preserves query row limits, and distinguishes its overall timeout', async () => {
  const runner = new QueryRunner(
    { ...settings, maxRows: 2 },
    async () => '',
    async () =>
      async (_input, { result }) => {
        result.fields(['name']);
        for (let i = 0; i < 5; i++) if (!result.row([`column_${i}`])) break;
      },
  );
  try {
    const description = await runner.inspect({ action: 'describe', name: 'fixture' });
    assert.equal(description.sections.columns?.rows.length, 5);
    assert.equal((await runner.query('SELECT 1')).rows.length, 2);
  } finally {
    await runner.close();
  }
  const inspector = new Inspector(
    { ...settings, timeoutMs: 20 },
    async (_input, signal) =>
      new Promise((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(new DatabaseError('CANCELED', 'canceled')), {
          once: true,
        });
      }),
  );
  // AbortSignal.timeout is unref'd; keep this deterministic async test alive independently.
  const timer = setTimeout(() => {}, 200);
  try {
    await assert.rejects(inspector.inspect({ action: 'describe', name: 'fixture' }), {
      code: 'TIMEOUT',
    });
  } finally {
    clearTimeout(timer);
  }
});

test('metadata cache expires, evicts entries, invalidates pending writes and caps aggregate output', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const inspector = new Inspector(settings, async () => result('value'));
  await inspector.inspect({ action: 'search', name: 'original' });
  assert((await inspector.inspect({ action: 'search', name: 'original' })).cache.hit);
  t.mock.timers.tick(60001);
  assert.equal((await inspector.inspect({ action: 'search', name: 'original' })).cache.hit, false);
  for (let i = 0; i < 64; i++) await inspector.inspect({ action: 'search', name: String(i) });
  assert.equal((await inspector.inspect({ action: 'search', name: 'original' })).cache.hit, false);
  let release!: (value: ReturnType<typeof result>) => void;
  const delayed = new Inspector(
    settings,
    async () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = delayed.inspect({ action: 'search' });
  delayed.clear();
  release(result('retired'));
  await pending;
  const fresh = delayed.inspect({ action: 'search' });
  release(result('fresh'));
  assert.equal((await fresh).cache.hit, false);
  const large = new Inspector(settings, async () => ({
    ...result(''),
    rows: Array.from({ length: 100 }, () => ['x'.repeat(2000)]),
  }));
  const value = await large.inspect({ action: 'describe', name: 'wide' });
  assert(Buffer.byteLength(JSON.stringify(value)) <= 256 * 1024);
  assert(Object.values(value.sections).some((section) => section.truncated));
});

test('journal compacts expired storage on startup and reports persistence failure without failing a call', async () => {
  const source = new Observatory();
  const expired = source.start({ connectionId: 'old', revision: 1, operation: 'inspect' });
  expired.startedAt = Date.now() - 8 * 86400000;
  const map = new Map(
    Array.from({ length: 2100 }, (_, i) => [String(i), { ...expired, requestId: String(i) }]),
  );
  const journal = new Observatory({
    entries: () => map.entries(),
    put: async (id, value) => {
      map.set(id, value);
    },
    delete: async (id) => map.delete(id),
  });
  await journal.close();
  assert.equal(map.size, 0);
  const broken = new Observatory({
    entries: () => new Map().entries(),
    put: async () => {
      throw new Error('disk');
    },
    delete: async () => false,
  });
  const trace = broken.start({ connectionId: 'failure', revision: 1, operation: 'inspect' });
  assert.equal(await broken.observe(trace, async () => 42), 42);
  await broken.close();
  assert(broken.writeFailures > 0);
  assert.equal(broken.snapshot('failure').active, 0);
  await source.close();
});
