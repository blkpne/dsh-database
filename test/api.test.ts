import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseError } from '../src/errors.js';
import { handleApi } from '../src/api.js';
import { ConnectionManager } from '../src/manager.js';

test('API rejects wrong method, wrong media, oversized bodies, invalid JSON/actions', async () => {
  const manager = {} as ConnectionManager;
  const req = (body: string, content = 'application/json') =>
    new Request('http://localhost/api/dsh-database', {
      method: 'POST',
      headers: { 'content-type': content },
      body,
    });
  assert.equal(
    (await handleApi(manager, new Request('http://localhost/api/dsh-database'))).status,
    405,
  );
  assert.equal((await handleApi(manager, req('{}', 'text/plain'))).status, 415);
  assert.equal((await handleApi(manager, req('x'.repeat(17000)))).status, 413);
  for (const body of [
    '{',
    '{"action":"query"}',
    '{"action":"toggle","id":"arbitrary","enabled":true}',
  ])
    assert.equal((await handleApi(manager, req(body))).status, 400);
});

test('API overload uses retryable HTTP status and rejects lookalike JSON media types', async () => {
  const overloaded = {
    save: async () => {
      throw new DatabaseError('BUSY', 'retry');
    },
  } as unknown as ConnectionManager;
  const request = (contentType: string) =>
    new Request('http://localhost/api/dsh-database', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: JSON.stringify({ action: 'save', connection: {} }),
    });
  assert.equal(
    (await handleApi(overloaded, request('application/json; charset=utf-8'))).status,
    429,
  );
  assert.equal((await handleApi(overloaded, request('application/json-unrelated'))).status, 415);
});

test('concurrent-window saves identify the exact saved connection for Client selection', async () => {
  const { savedConnection } = await import('../src/client/model.js');
  const records = new Map();
  const manager = new ConnectionManager(
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
  );
  const save = async (connection: unknown, id?: string, revision?: number) => {
    const response = await handleApi(
      manager,
      new Request('http://localhost/api/dsh-database', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'save', connection, id, revision }),
      }),
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    const fields = { host: 'localhost', user: 'reader' };
    await save({ ...fields, name: 'Original' });
    const other = await save({ ...fields, name: 'Other window' });
    const own = await save({ ...fields, name: 'This window' });
    assert.notEqual(own.connectionId, other.connectionId);
    const selected = savedConnection(own);
    assert.equal(selected.name, 'This window');
    await manager.toggle(selected.id, true, selected.revision);
    assert.equal(manager.list().find((c) => c.id === other.connectionId)?.enabled, false);
    const renamed = await save({ ...fields, name: 'Renamed' }, selected.id, 2);
    assert.equal(savedConnection(renamed).id, own.connectionId);
    assert.equal(savedConnection(renamed).name, 'Renamed');
    assert.throws(() => savedConnection({ connections: own.connections, connectionId: 'missing' }));
  } finally {
    await manager.close();
  }
});
