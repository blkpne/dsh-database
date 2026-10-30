import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { ConnectionManager } from '../src/manager.js';
import {
  connectionInput,
  connectionRecord,
  safeError,
  type ConnectionRecord,
} from '../src/schema.js';
import { handleApi } from '../src/api.js';
import { ResultCollector } from '../src/result.js';
import { Inspector, inspectInput } from '../src/inspect.js';
import { harness } from './harness.js';

const fields = { name: 'Fixture', host: 'localhost', user: 'reader' };
const result = {
  columns: ['version'],
  rows: [['fixture']],
  rowCount: 1,
  truncated: false,
  durationMs: 0,
  readOnly: true as const,
};
function managerFixture() {
  const records = new Map<string, ConnectionRecord>();
  const secrets = new Map<string, string>();
  let failCleanup = false,
    failSecret = 0,
    deletions = 0,
    failStore = false;
  const manager = new ConnectionManager(
    {
      entries: () => records.entries(),
      get: (id) => records.get(id),
      put: async (id, value) => {
        if (failStore) throw new Error('store-failure');
        records.set(id, value);
      },
      delete: async (id) => records.delete(id),
    },
    {
      read: async (ref) => secrets.get(ref) ?? '',
      set: async (ref, value) => {
        secrets.set(ref, value);
      },
      delete: async (ref) => {
        deletions++;
        if (failSecret-- > 0) throw new Error('secret-value');
        secrets.delete(ref);
      },
    },
    async () => async () => {
      if (failCleanup) throw new Error('private driver failure');
    },
    {},
    () => ({
      query: async () => result,
      mongo: async () => result,
      test: async () => result,
      close: async () => {},
    }),
  );
  const api = async (input: unknown) => {
    const response = await handleApi(
      manager,
      new Request('http://localhost/api/dsh-database', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
    );
    return response.json();
  };
  return {
    manager,
    records,
    secrets,
    api,
    cleanup: (value: boolean) => {
      failCleanup = value;
    },
    secretFailures: (value: number) => {
      failSecret = value;
    },
    storeFailure: () => {
      failStore = true;
    },
    deletions: () => deletions,
  };
}

test('TLS defaults are consistent for input and storage; edits preserve explicit plaintext', async () => {
  assert.equal(connectionInput.parse(fields).tls, true);
  const old = connectionRecord.parse({
    ...fields,
    id: '0123456789abcdef',
    enabled: false,
    revision: 1,
    createdAt: '',
    updatedAt: '',
  });
  assert.equal(old.tls, true);
  const f = managerFixture();
  f.records.set(old.id, { ...old, tls: false });
  assert.equal((await f.manager.save(fields, old.id, 1)).connections[0]!.tls, false);
  assert.equal(
    (await f.manager.save({ ...fields, tls: true }, old.id, 2)).connections[0]!.tls,
    true,
  );
  await f.manager.close();
});

for (const action of ['save', 'toggle', 'remove'] as const)
  test(`${action}: committed cleanup failure returns latest safe snapshot; retry uses new revision`, async () => {
    const f = managerFixture();
    const [saved] = (await f.manager.save({ ...fields, password: 'fixture-secret' })).connections;
    const [old] = await f.manager.toggle(saved!.id, true, saved!.revision);
    f.cleanup(true);
    const failed = await f.api({
      action,
      id: old!.id,
      revision: old!.revision,
      ...(action === 'save'
        ? { connection: { ...fields, name: 'Changed', password: 'replacement-secret' } }
        : action === 'toggle'
          ? { enabled: false }
          : {}),
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.committed, true);
    assert.equal(failed.connectionId, old!.id);
    assert.equal(failed.code, 'CLEANUP_FAILED');
    assert(
      !JSON.stringify(failed).match(/fixture-secret|replacement-secret|passwordRef|private driver/),
    );
    if (action === 'remove') assert.deepEqual(failed.connections, []);
    else {
      assert.equal(failed.connections[0].revision, old!.revision + 1);
      f.cleanup(false);
      const retry = await f.api({
        action: 'toggle',
        id: old!.id,
        revision: failed.connections[0].revision,
        enabled: false,
      });
      assert.equal(retry.ok, true);
    }
    f.cleanup(false);
    await f.manager.close();
  });

test('credential cleanup retries are bounded and permanent failure is visible after commit', async () => {
  const f = managerFixture();
  const [record] = (await f.manager.save({ ...fields, password: 'fixture-secret' })).connections;
  f.secretFailures(2);
  const [next] = (
    await f.manager.save({ ...fields, password: 'rotated' }, record!.id, record!.revision)
  ).connections;
  assert.equal(f.deletions(), 3);
  assert.equal(f.secrets.size, 1);
  f.secretFailures(3);
  const response = await f.api({ action: 'remove', id: next!.id, revision: next!.revision });
  assert.equal(response.code, 'CREDENTIAL_CLEANUP_FAILED');
  assert.equal(response.committed, true);
  assert.equal(f.deletions(), 6);
  assert(!JSON.stringify(response).includes('rotated'));
  await f.manager.close();
});

test('failure before persistence never claims a committed change', async () => {
  const f = managerFixture();
  f.storeFailure();
  const response = await f.api({
    action: 'save',
    connection: { ...fields, password: 'fixture-secret' },
  });
  assert.equal(response.ok, false);
  assert.equal(response.committed, undefined);
  assert.equal(f.records.size, 0);
  assert.equal(f.secrets.size, 0);
  await f.manager.close();
});

test('ordinary probes record saved versus draft settings without marking stale health as current', async () => {
  const f = managerFixture();
  const [record] = (await f.manager.save(fields)).connections;
  await f.manager.test(fields, record!.id);
  await f.manager.test({ ...fields, host: 'draft.invalid' }, record!.id);
  const snapshot = f.manager.observations.snapshot(record!.id);
  assert.equal(snapshot.lastProbe?.operation, 'test');
  assert.equal(snapshot.lastProbe?.draft, false);
  assert.equal(snapshot.records[0]?.draft, true);
  assert(!JSON.stringify(snapshot).includes('draft.invalid'));
  await f.manager.close();
});

test('result reasons distinguish rows, bytes, cells and unsupported values; never return partial rows', () => {
  const rows = new ResultCollector(1);
  rows.fields(['v']);
  rows.row([1]);
  rows.row([2]);
  assert.equal(rows.finish().truncationReason, 'row_limit');
  const cell = new ResultCollector(5);
  cell.fields(['v']);
  cell.row(['x'.repeat(65536)]);
  assert.equal(cell.finish().truncationReason, 'cell_limit');
  assert.equal(cell.finish().rowCount, 0);
  const bytes = new ResultCollector(20);
  bytes.fields(['v']);
  for (let i = 0; i < 6; i++) bytes.row(['x'.repeat(60000)]);
  assert.equal(bytes.finish().truncationReason, 'byte_limit');
  const unsafe = new ResultCollector(1);
  unsafe.fields(['v']);
  unsafe.row([() => 'private']);
  assert.equal(unsafe.finish().truncationReason, 'unsupported_value');
});

test('PostgreSQL column-only catalog result redacts permission marker and omits whole-object definitions', async () => {
  let calls = 0;
  const inspector = new Inspector(
    connectionInput.parse({ ...fields, engine: 'postgresql', database: 'fixture' }),
    async () => {
      calls++;
      return { ...result, columns: ['name', '__table_select'], rows: [['id', false]] };
    },
  );
  const value = await inspector.inspect({ action: 'describe', name: 'items' });
  assert.equal(calls, 1);
  assert.deepEqual(value.sections.columns?.columns, ['name']);
  assert.deepEqual(value.sections.columns?.rows, [['id']]);
  for (const name of ['keys', 'indexes', 'comments'])
    assert.equal(value.sections[name]?.status, 'denied');
});

test('safe validation never echoes unknown or nested database keys', () => {
  const parsed = inspectInput.safeParse({
    action: 'search',
    offset: -1,
    secretCredential: 'private',
  });
  assert.equal(parsed.success, false);
  if (!parsed.success) {
    const value = safeError(parsed.error);
    assert.equal(value.code, 'INVALID_INPUT');
    assert(value.message.includes('offset'));
    assert(!value.message.includes('secretCredential'));
    assert(!value.message.includes('private'));
  }
});

test('metadata fully omitted by a cell budget is incomplete, not an empty schema', async () => {
  const inspector = new Inspector(connectionInput.parse(fields), async () => ({
    ...result,
    columns: ['name'],
    rows: [],
    rowCount: 0,
    truncated: true,
    truncationReason: 'cell_limit',
  }));
  const value = await inspector.inspect({ action: 'search' });
  assert.equal(value.sections.objects?.status, 'available');
  assert.equal(value.sections.objects?.truncationReason, 'cell_limit');
  assert.equal(value.nextOffset, null);
});

test('real DSH bridge categorizes invalid inspect and query parameters before MCP dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-review-'));
  const app = await harness(directory);
  try {
    const saved = (await app.api({ action: 'save', connection: fields })).connections[0];
    const record = (
      await app.api({ action: 'toggle', id: saved.id, revision: saved.revision, enabled: true })
    ).connections[0];
    for (const args of [
      { action: 'search', limit: 101 },
      { action: 'search', offset: -1 },
      { action: 'describe' },
    ]) {
      const failure = await app.ctx.tools.execute({
        signal: new AbortController().signal,
        name: record.inspectToolName,
        callId: ToolCallId(`bad-${JSON.stringify(args)}`),
        arguments: args,
      });
      assert(failure.isError);
      assert(JSON.stringify(failure).includes('INVALID_INPUT'));
      assert(!JSON.stringify(failure).includes('DATABASE_ERROR'));
    }
    const valid = await app.ctx.tools.execute({
      signal: new AbortController().signal,
      name: record.inspectToolName,
      callId: ToolCallId('good'),
      arguments: { action: 'capabilities' },
    });
    assert(!valid.isError);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
