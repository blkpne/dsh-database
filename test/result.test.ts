import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResultCollector, MAX_RESULT_BYTES, MAX_CELL_BYTES } from '../src/result.js';

const collector = () => {
  const result = new ResultCollector(5000);
  result.fields(['value']);
  return result;
};

test('budget includes UTF-8 escaping, row separators, metadata and the final JSON envelope', () => {
  for (const value of ['中'.repeat(700), '\n'.repeat(700), 'x', []]) {
    const result = collector();
    while (result.row([value])) {}
    const output = result.finish();
    assert(output.truncated);
    assert(Buffer.byteLength(JSON.stringify(output)) <= MAX_RESULT_BYTES);
    assert(output.rowCount > 0);
  }
});

test('exact cell boundary accepts whole cells and base64 expansion is budgeted', () => {
  assert(collector().row(['x'.repeat(MAX_CELL_BYTES - 2)]));
  assert(!collector().row(['x'.repeat(MAX_CELL_BYTES - 1)]));
  assert(!collector().row([Buffer.alloc(MAX_CELL_BYTES)]));
  const result = collector();
  assert(result.row([Buffer.from('abc')]));
  assert.deepEqual(result.finish().rows, [[{ encoding: 'base64', data: 'YWJj' }]]);
});

test('truncation never traverses the next row or invokes database value accessors/toJSON', () => {
  let touched = 0;
  const dangerous = {
    get value() {
      touched++;
      throw new Error('private');
    },
  };
  const result = new ResultCollector(1);
  result.fields(['value']);
  assert(result.row([1]));
  assert(!result.row([dangerous]));
  assert(!collector().row([dangerous]));
  assert(
    !collector().row([
      {
        toJSON() {
          touched++;
          throw new Error('private');
        },
      },
    ]),
  );
  assert.equal(touched, 0);
});

test('cycles, excessive nesting and invalid dates truncate without escaping driver callbacks', () => {
  const cyclic: unknown[] = [];
  cyclic.push(cyclic);
  let deep: unknown = 1;
  for (let i = 0; i < 40; i++) deep = { value: deep };
  for (const value of [cyclic, deep, new Date(NaN)]) {
    const result = collector();
    assert(!result.row([value]));
    assert.deepEqual(result.finish().rows, []);
    assert(result.finish().truncated);
  }
});

test('a huge nested value is rejected before later properties are read', () => {
  let visited = false;
  const value = {
    large: 'x'.repeat(8 * 1024 * 1024),
    get tail() {
      visited = true;
      return 1;
    },
  };
  assert(!collector().row([value]));
  assert.equal(visited, false);
});

test('shared references are allowed; special keys cannot alter output prototypes', () => {
  const item = { x: 1 };
  const result = collector();
  assert(result.row([[item, item, JSON.parse('{"__proto__":{"polluted":true}}')]]));
  const row = result.finish().rows[0]![0] as object[];
  assert.deepEqual(row.slice(0, 2), [item, item]);
  assert.equal(Object.getPrototypeOf(row[2]), Object.prototype);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert(JSON.stringify(row[2]).includes('__proto__'));
});

test('repeated column events cannot reset the byte budget or relabel existing rows', () => {
  const result = collector();
  result.row([1]);
  result.fields(['different']);
  assert.equal(result.row([2]), false);
  assert.deepEqual(result.finish().columns, ['value']);
  assert.deepEqual(result.finish().rows, [[1]]);
});
