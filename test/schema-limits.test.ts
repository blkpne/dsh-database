import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { mongoInput } from '../src/mongo.js';
import { accessPolicy } from '../src/policy.js';
import { queryResult } from '../src/schema.js';
import { inspectInput, inspectResult } from '../src/inspect.js';
import { jsonValue } from '../src/json-schema.js';

test('oversized schema collections are rejected before their elements are validated', () => {
  const cases = [
    {
      schema: mongoInput,
      field: 'pipeline',
      limit: 40,
      input: { operation: 'aggregate', collection: 'fixture' },
    },
    { schema: accessPolicy, field: 'sessionIds', limit: 20, input: {} },
    {
      schema: queryResult,
      field: 'rows',
      limit: 5000,
      input: { columns: [], rowCount: 0, truncated: false, durationMs: 0, readOnly: true },
    },
  ];
  for (const { schema, field, limit, input } of cases) {
    const values = new Array(limit + 1).fill(null);
    Object.defineProperty(values, 0, {
      get() {
        assert.fail(`Oversized ${field} must be rejected before traversing elements`);
      },
    });
    const result = schema.safeParse({ ...input, [field]: values });
    assert.equal(result.success, false);
    assert(
      result.error?.issues.some((issue) => issue.code === 'too_big' && issue.path[0] === field),
    );
  }
});

test('MCP schemas remain convertible when the host pins a different Zod minor', async () => {
  const hostRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-storage-domain'));
  const { z: hostZod } = await import(pathToFileURL(hostRequire.resolve('zod')).href);
  for (const schema of [mongoInput, queryResult, inspectInput, inspectResult]) {
    const converted = hostZod.toJSONSchema(schema);
    const current = z.toJSONSchema(schema);
    assert.equal(converted.type, 'object');
    assert.deepEqual(converted.required, current.required);
    assert.deepEqual(Object.keys(converted.properties), Object.keys(current.properties ?? {}));
  }
});

test('JSON result values accept nested dictionaries and reject non-JSON values', () => {
  const value = { nested: [null, false, 42, 'fixture', { amount: 1.5 }], '': { '\n中文': true } };
  assert.deepEqual(jsonValue.parse(value), value);
  for (const invalid of [
    undefined,
    NaN,
    Infinity,
    1n,
    new Date(),
    () => {},
    { nested: undefined },
    { '\n': undefined },
  ])
    assert.equal(jsonValue.safeParse(invalid).success, false);
});
