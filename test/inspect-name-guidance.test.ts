import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Inspector, type SqlStatement } from '../src/inspect.js';
import { connectionInput } from '../src/schema.js';

const config = connectionInput.parse({
  name: 'Literal metadata names',
  engine: 'postgresql',
  host: 'localhost',
  user: 'reader',
  database: 'fixture',
});

function fixture(status: 'empty' | 'found' | 'denied') {
  const calls: SqlStatement[] = [];
  const inspector = new Inspector(config, async (statement) => {
    assert.equal(statement.kind, 'sql');
    const sql = statement as SqlStatement;
    calls.push(sql);
    if (status === 'denied') throw { code: '42501', message: 'private driver detail' };
    return {
      columns: ['name'],
      rows: status === 'found' ? [['id']] : [],
      rowCount: status === 'found' ? 1 : 0,
      truncated: false,
      durationMs: 0,
      readOnly: true,
    };
  });
  return { inspector, calls };
}

test('empty dotted SQL object lookup explains separate schema fields and caches the hint without guessing scope', async () => {
  const { inspector, calls } = fixture('empty');
  const input = { action: 'describe', name: 'sales.orders' };
  const result = await inspector.inspect(input);
  assert.equal(result.sections.columns?.status, 'empty');
  assert.match(result.sections.columns?.note ?? '', /name.*schema/);
  assert.match(result.sections.columns?.note ?? '', /literal/);
  assert(!result.sections.columns?.note?.includes('sales.orders'));
  assert(calls.length > 0);
  assert(calls.every((sql) => sql.values.includes('sales.orders')));
  assert(calls.every((sql) => !sql.values.includes('sales') && !sql.values.includes('orders')));
  const before = calls.length;
  const cached = await inspector.inspect(input);
  assert.equal(cached.cache.hit, true);
  assert.equal(cached.sections.columns?.note, result.sections.columns?.note);
  assert.equal(calls.length, before);
});

test('found dotted literal names and denied lookups retain their normal metadata meaning', async () => {
  for (const status of ['found', 'denied'] as const) {
    const { inspector, calls } = fixture(status);
    const result = await inspector.inspect({
      action: 'describe',
      schema: 'sales',
      name: 'orders.archive',
    });
    assert.equal(result.sections.columns?.status, status === 'found' ? 'available' : 'denied');
    assert.equal(result.sections.columns?.note, undefined);
    assert(calls.every((sql) => sql.values.includes('orders.archive')));
    assert(!JSON.stringify(result).includes('private driver detail'));
  }
});

test('an ordinary empty unqualified name keeps the ordinary empty result', async () => {
  const { inspector } = fixture('empty');
  const result = await inspector.inspect({ action: 'describe', schema: 'sales', name: 'orders' });
  assert.equal(result.sections.columns?.status, 'empty');
  assert.equal(result.sections.columns?.note, undefined);
});

test('PostgreSQL timestamp metadata explains conversion direction while preserving column-only visibility notes', async () => {
  const inspector = new Inspector(config, async () => ({
    columns: ['name', 'data_type', '__table_select'],
    rows: [['occurred_at', 'timestamp with time zone', false]],
    rowCount: 1,
    truncated: false,
    durationMs: 0,
    readOnly: true,
  }));
  const result = await inspector.inspect({ action: 'describe', schema: 'sales', name: 'events' });
  assert.deepEqual(result.sections.columns?.rows, [['occurred_at', 'timestamp with time zone']]);
  assert.match(result.sections.columns?.note ?? '', /Only columns with SELECT permission/);
  assert.match(result.sections.columns?.note ?? '', /timestamp WITHOUT time zone/);
  assert.match(result.sections.columns?.note ?? '', /AT TIME ZONE on timestamptz/);
  assert.equal(result.sections.keys?.status, 'denied');
  assert.equal(result.sections.indexes?.status, 'denied');
});
