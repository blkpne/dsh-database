import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueryRunner } from '../src/query.js';
import { QueryCapacity } from '../src/limits.js';
import { connectionInput } from '../src/schema.js';
import { abortable } from '../src/adapters/types.js';
import type { Adapter } from '../src/adapters/types.js';

const config = connectionInput.parse({ name: 'Fixture', host: 'localhost', user: 'fixture' });

test('shared capacity rejects before secret lookup and remains occupied until cleanup finishes', async () => {
  const capacity = new QueryCapacity(1);
  let read = 0;
  let entered!: () => void;
  let cleaned!: () => void;
  const ready = new Promise<void>((r) => {
    entered = r;
  });
  const cleanup = new Promise<void>((r) => {
    cleaned = r;
  });
  const adapter: Adapter = async (_input, { signal }) => {
    entered();
    try {
      await abortable(new Promise<void>(() => {}), signal, () => {});
    } finally {
      await cleanup;
    }
  };
  const first = new QueryRunner(
    config,
    async () => '',
    async () => adapter,
    { capacity },
  );
  const second = new QueryRunner(
    config,
    async () => {
      read++;
      return '';
    },
    async () =>
      async (_input, { result }) => {
        result.fields(['ok']);
        result.row([1]);
      },
    { capacity },
  );
  const pending = assert.rejects(first.query('SELECT 1'), { code: 'CANCELED' });
  await ready;
  await assert.rejects(second.query('SELECT 1'), { code: 'BUSY' });
  const closing = first.close();
  await assert.rejects(second.query('SELECT 1'), { code: 'BUSY' });
  assert.equal(read, 0);
  cleaned();
  await closing;
  await pending;
  assert.equal((await second.query('SELECT 1')).rowCount, 1);
  assert.equal(read, 1);
  await second.close();
});

test('failure and timeout release global capacity for the next connection', async () => {
  const capacity = new QueryCapacity(1);
  const timeout = new QueryRunner(
    { ...config, timeoutMs: 100 },
    () => new Promise(() => {}),
    async () => async () => {},
    { capacity },
  );
  await assert.rejects(timeout.query('SELECT 1'), { code: 'TIMEOUT' });
  const failure = new QueryRunner(
    config,
    async () => {
      throw new Error('private');
    },
    async () => async () => {},
    { capacity },
  );
  await assert.rejects(failure.query('SELECT 1'), { code: 'DATABASE_ERROR' });
  const release = capacity.acquire();
  release();
  release();
  const next = capacity.acquire();
  assert.throws(() => capacity.acquire(), { code: 'BUSY' });
  next();
  await timeout.close();
  await failure.close();
});

test('a throwing cancellation callback does not escape the abort event or leave a pending race', async () => {
  const controller = new AbortController();
  const pending = assert.rejects(
    abortable(new Promise<void>(() => {}), controller.signal, () => {
      throw new Error('driver failure');
    }),
  );
  controller.abort();
  await pending;
});

test('driver configuration is a snapshot containing neither credential references nor input secrets', async () => {
  const input = { ...config, password: 'fixture', passwordRef: 'DSH_DATABASE_FIXTURE' };
  const runner = new QueryRunner(
    input,
    async () => '',
    async () => async (_sql, execution) => {
      assert.equal(execution.config.host, 'localhost');
      assert.equal('password' in execution.config, false);
      assert.equal('passwordRef' in execution.config, false);
    },
  );
  input.host = 'mutated.example';
  await runner.query('SELECT 1');
  await runner.close();
});
