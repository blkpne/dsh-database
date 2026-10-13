import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { harness } from './harness.js';
import * as Database from '../src/index.js';

test('failed journal open releases the connection domain so initialization can be retried', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-database-open-failure-'));
  const app = await harness(directory);
  try {
    await app.api({
      action: 'save',
      connection: { name: 'Retained', host: 'localhost', user: 'unused' },
    });
    await app.plugin.dispose();
    const journal = join(directory, 'storage/dsh_database_test_operations.json');
    await writeFile(journal, '{malformed');
    await assert.rejects(Database.apply(app.ctx, { namespace: 'test' }));
    assert.equal(Boolean(app.ctx.storageDomain.get('dsh_database_test')), false);
    assert.equal(Boolean(app.ctx.storageDomain.get('dsh_database_test_operations')), false);
    await rm(journal);
    const reloaded = await app.mount();
    try {
      assert.equal((await app.api({ action: 'list' })).connections[0].name, 'Retained');
    } finally {
      await reloaded.dispose();
    }
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('actual Cordis Host: API, credentials, ToolRuntime, restore, unload/reload, storage persistence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-database-host-'));
  const app = await harness(directory);
  try {
    const secret = 'nonproduction-placeholder';
    let data = await app.api({
      action: 'save',
      connection: { name: 'Host test', host: 'localhost', user: 'unused', password: secret },
    });
    let record = data.connections[0];
    assert.equal(app.ctx.tools.schemas().length, 0);
    data = await app.api({
      action: 'toggle',
      id: record.id,
      revision: record.revision,
      enabled: true,
    });
    record = data.connections[0];
    assert.equal(record.status, 'enabled');
    assert.equal(app.ctx.tools.schemas()[0]?.name, record.toolName);
    const rejected = await app.ctx.tools.execute({
      callId: ToolCallId('test-host-call'),
      name: record.toolName,
      arguments: { sql: 'DELETE FROM forbidden' },
      signal: new AbortController().signal,
    });
    assert.equal(rejected.isError, true);
    assert(JSON.stringify(rejected).includes('READ_ONLY_VIOLATION'));
    const metadata = await readFile(join(directory, 'storage/dsh_database_test.json'), 'utf8');
    assert(!metadata.includes(secret));
    // Windows stat mode does not represent NTFS ACLs; retain this POSIX-only assertion.
    if (process.platform !== 'win32') {
      const permission = (await stat(join(directory, 'credentials.yaml'))).mode & 0o777;
      assert.equal(permission, 0o600);
    }
    await app.plugin.dispose();
    assert.equal(app.ctx.tools.schemas().length, 0);
    const fresh = await app.mount();
    try {
      assert.equal(app.ctx.tools.schemas()[0]?.name, record.toolName);
      const restored = await app.api({ action: 'list' });
      assert.equal(restored.connections[0].hasPassword, true);
      await app.api({ action: 'remove', id: record.id, revision: record.revision });
      assert.equal(app.ctx.tools.schemas().length, 0);
      assert(!(await readFile(join(directory, 'credentials.yaml'), 'utf8')).includes(secret));
    } finally {
      await fresh.dispose();
    }
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('all engines mount distinct schemas, reject writes via actual ToolRuntime/MCP, and restore', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-database-multi-host-'));
  const app = await harness(directory);
  try {
    const expected: string[] = [];
    for (const engine of ['mysql', 'mariadb', 'postgresql', 'sqlserver', 'oracle', 'mongodb']) {
      const saved = await app.api({
        action: 'save',
        connection: {
          engine,
          name: engine,
          host: 'localhost',
          user: 'unused',
          database: 'example',
        },
      });
      const record = saved.connections.find((c: any) => c.engine === engine);
      const enabled = await app.api({
        action: 'toggle',
        id: record.id,
        revision: record.revision,
        enabled: true,
      });
      assert.equal(enabled.connections.find((c: any) => c.id === record.id).status, 'enabled');
      expected.push(record.toolName, record.inspectToolName);
      const outcome = await app.ctx.tools.execute({
        callId: ToolCallId(`test-${engine}`),
        name: record.toolName,
        arguments:
          engine === 'mongodb'
            ? { operation: 'aggregate', collection: 'x', pipeline: [{ $out: 'sink' }] }
            : { sql: 'DELETE FROM forbidden' },
        signal: new AbortController().signal,
      });
      assert.equal(outcome.isError, true);
      assert(JSON.stringify(outcome).includes('READ_ONLY_VIOLATION'));
      await assert.rejects(
        app.api({
          action: 'save',
          id: record.id,
          revision: record.revision + 1,
          connection: {
            engine: engine === 'mysql' ? 'postgresql' : 'mysql',
            name: engine,
            host: 'localhost',
            user: 'unused',
            database: 'example',
          },
        }),
        { code: 'INVALID_INPUT' },
      );
    }
    assert.deepEqual(
      app.ctx.tools
        .schemas()
        .map((s) => s.name)
        .sort(),
      expected.sort(),
    );
    await app.plugin.dispose();
    assert.equal(app.ctx.tools.schemas().length, 0);
    const fresh = await app.mount();
    try {
      assert.deepEqual(
        app.ctx.tools
          .schemas()
          .map((s) => s.name)
          .sort(),
        expected,
      );
    } finally {
      await fresh.dispose();
    }
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('v1 MySQL storage reopens without changing IDs, passwords, revisions or enabled state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-database-defaults-'));
  let app = await harness(directory);
  try {
    const saved = await app.api({
      action: 'save',
      connection: {
        name: 'Defaulted fields',
        host: 'localhost',
        user: 'unused',
        password: 'nonproduction-placeholder',
      },
    });
    const record = saved.connections[0];
    await app.api({ action: 'toggle', id: record.id, revision: record.revision, enabled: true });
    await app.close();
    const file = join(directory, 'storage/dsh_database_test.json');
    const old = JSON.parse(await readFile(file, 'utf8'));
    const omitDefaultedFields = (value: any) => {
      if (!value || typeof value !== 'object') return;
      if (value.id === record.id)
        for (const key of ['engine', 'authSource', 'replicaSet', 'mongoSrv']) delete value[key];
      for (const nested of Object.values(value)) omitDefaultedFields(nested);
    };
    omitDefaultedFields(old);
    await writeFile(file, JSON.stringify(old));
    app = await harness(directory);
    const restored = (await app.api({ action: 'list' })).connections[0];
    assert.equal(restored.engine, 'mysql');
    assert.equal(restored.id, record.id);
    assert.equal(restored.revision, record.revision + 1);
    assert.equal(restored.hasPassword, true);
    assert.equal(restored.status, 'enabled');
    assert.equal(restored.toolName, record.toolName);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
