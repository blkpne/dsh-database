import assert from 'node:assert/strict';
import test from 'node:test';
import { connectDatabaseMcp } from '../src/mcp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { oracleConstraints, type CatalogRead } from '../src/adapters/oracle-metadata.js';
import { ResultCollector } from '../src/result.js';
import { Inspector, inspectInput, type MetadataRequest } from '../src/inspect.js';
import { connectionInput } from '../src/schema.js';

const request = (section = 'foreignKeys'): MetadataRequest => ({
  kind: 'metadata',
  section,
  input: inspectInput.parse({ action: 'describe', schema: 'Source', name: 'Child' }),
});
const run = async (
  read: CatalogRead,
  section = 'foreignKeys',
  signal = new AbortController().signal,
) => {
  const result = new ResultCollector(500);
  await oracleConstraints(request(section), read, result, signal);
  return result.finish();
};
const fixture =
  (hidden = false): CatalogRead =>
  async (q, accept) => {
    assert(!q.text.includes('JOIN'));
    assert(q.values.length <= 34);
    let rows: unknown[][];
    if (q.text.includes('constraint_type IN')) {
      if (q.values[0] === 'Source') {
        assert.deepEqual(q.values, ['Source', 'Child', 'R', 'R']);
        rows = [
          ['Source', 'FK1', 'R', 'Child', 'One', 'Same'],
          ['Source', 'FK2', 'R', 'Child', 'Two', 'Same'],
        ];
      } else rows = hidden ? [] : [[q.values[0], 'Same', 'P', 'Parent', null, null]];
    } else if (q.text.includes('table_name=:2')) {
      assert.equal(q.values.length, 34);
      rows = [
        ['Source', 'FK1', 'Child', 'X10', '10'],
        ['Source', 'FK1', 'Child', 'X2', '2'],
        ['Source', 'FK2', 'Child', 'Y', '1'],
      ];
    } else if (q.text.includes('FROM all_constraints')) {
      rows = hidden ? [] : [[q.values[0], 'Same', 'Parent']];
    } else
      rows =
        q.values[0] === 'One'
          ? [
              ['One', 'Same', 'Parent', 'A', '2'],
              ['One', 'Same', 'Parent', 'B', '10'],
            ]
          : [['Two', 'Same', 'Parent', 'C', '1']];
    for (const row of rows) if (!accept(row)) break;
  };

test('Oracle bounded catalog assembly keeps numeric position and owner-qualified target identity', async () => {
  assert.deepEqual((await run(fixture())).rows, [
    ['FK1', 'X2', '2', 'One', 'Same', 'Parent', 'A'],
    ['FK1', 'X10', '10', 'One', 'Same', 'Parent', 'B'],
    ['FK2', 'Y', '1', 'Two', 'Same', 'Parent', 'C'],
  ]);
});
test('Oracle hidden targets retain source FK facts but never reconstruct target names', async () => {
  const rows = (await run(fixture(true))).rows;
  assert.equal(rows.length, 3);
  assert(rows.every((row) => row[5] === null && row[6] === null));
});
test('Oracle source scope and hostile names stay in binds; unsupported internal requests fail closed', async () => {
  const r = request('keys');
  r.input.schema = "x' OR '1'='1";
  r.input.name = 'Mixed Table';
  await oracleConstraints(
    r,
    async (q) => {
      assert.deepEqual(q.values, [r.input.schema, r.input.name, 'P', 'U']);
      assert(!q.text.includes(r.input.schema!));
      assert(!q.text.includes(r.input.name!));
    },
    new ResultCollector(500),
    new AbortController().signal,
  );
  await assert.rejects(
    run(async () => {
      throw new Error('must not read');
    }, 'arbitrary'),
  );
});
test('Oracle probes row 501, preserves exactly 500 rows, and marks incomplete components instead of empty metadata', async () => {
  for (const count of [500, 501]) {
    let reads = 0;
    const out = await run(async (q, accept) => {
      reads++;
      const names = q.text.includes('constraint_type IN')
        ? Array.from({ length: count }, (_, i) => `K${i}`)
        : q.values.slice(2).filter(Boolean);
      for (const name of names)
        if (
          !accept(
            q.text.includes('constraint_type IN')
              ? ['Source', name, 'P', 'Child', null, null]
              : ['Source', name, 'Child', name, '1'],
          )
        )
          break;
    }, 'keys');
    assert.equal(out.truncated, count === 501);
    assert.equal(out.rows.length, count === 500 ? 500 : 0);
    if (count === 501) {
      assert.equal(out.truncationReason, 'row_limit');
      assert.equal(reads, 1);
    }
  }
});
test('Oracle intermediate row budget accumulates across all source and target batches', async () => {
  const out = await run(async (q, accept) => {
    const source = q.text.includes('constraint_type IN') && q.values[0] === 'Source';
    const sourceColumns =
      q.text.includes('FROM all_cons_columns') && q.text.includes('table_name=:2');
    const target = q.text.includes('FROM all_constraints');
    const names = source
      ? Array.from({ length: 500 }, (_, i) => `K${i}`)
      : q.values.slice(sourceColumns ? 2 : 1).filter(Boolean);
    for (const name of names) {
      const rows = source
        ? [['Source', name, 'R', 'Child', 'Target', name]]
        : target
          ? [['Target', name, 'Parent']]
          : [
              [
                sourceColumns ? 'Source' : 'Target',
                name,
                sourceColumns ? 'Child' : 'Parent',
                'A',
                '1',
              ],
              [
                sourceColumns ? 'Source' : 'Target',
                name,
                sourceColumns ? 'Child' : 'Parent',
                'B',
                '2',
              ],
            ];
      for (const row of rows) if (!accept(row)) return;
    }
  });
  assert.equal(out.rows.length, 0);
  assert.equal(out.truncated, true);
  assert.equal(out.truncationReason, 'row_limit');
});
test('Oracle intermediate byte budget is cumulative and cannot present a truncated component as complete', async () => {
  const out = await run(async (q, accept) => {
    for (let i = 0; i < 500; i++) {
      const n = `K${i}`.padEnd(128, 'n');
      if (!accept(['S'.repeat(128), n, 'R', 'T'.repeat(128), 'O'.repeat(128), 'N'.repeat(128)]))
        return;
    }
  });
  assert.equal(out.rows.length, 0);
  assert.equal(out.truncated, true);
  assert.equal(out.truncationReason, 'byte_limit');
});
test('Oracle section checks cancellation between catalog reads and before assembly', async () => {
  const controller = new AbortController();
  let reads = 0;
  await assert.rejects(
    run(
      async (q, accept) => {
        await fixture()(q, accept);
        if (++reads === 2) controller.abort();
      },
      'foreignKeys',
      controller.signal,
    ),
  );
  assert.equal(reads, 2);
});
test('Inspector exposes incomplete Oracle components as available and truncated, not empty', async () => {
  const config = connectionInput.parse({
    name: 'Oracle',
    engine: 'oracle',
    host: 'localhost',
    database: 'FREEPDB1',
    user: 'reader',
  });
  const inspector = new Inspector(config, async (input, signal) => {
    const result = new ResultCollector(500);
    if (input.kind === 'metadata')
      await oracleConstraints(
        input,
        async (_q, accept) => {
          for (let i = 0; i < 501; i++)
            if (!accept(['Source', `K${i}`, 'P', 'Child', null, null])) break;
        },
        result,
        signal!,
      );
    else result.fields([]);
    return result.finish();
  });
  const out = await inspector.inspect({ action: 'describe', schema: 'Source', name: 'Child' });
  assert.equal(out.sections.keys?.status, 'available');
  assert.equal(out.sections.keys?.truncated, true);
  assert.equal(out.sections.keys?.truncationReason, 'row_limit');
  assert.deepEqual(out.sections.keys?.rows, []);
  const mcp = await connectDatabaseMcp(
    'incomplete Oracle metadata',
    async () => {
      throw new Error('query not requested');
    },
    undefined,
    { inspect: (input, signal) => inspector.inspect(input, signal) },
  );
  try {
    const response = CallToolResultSchema.parse(
      await mcp.client.callTool({
        name: 'inspect',
        arguments: { action: 'describe', schema: 'Source', name: 'Child' },
      }),
    );
    assert.equal(response.isError, undefined);
    const json = response.structuredContent as typeof out;
    assert.equal(json.sections.keys?.status, 'available');
    assert.equal(json.sections.keys?.truncated, true);
    const text = response.content.find((part) => part.type === 'text');
    assert(text?.type === 'text');
    assert.equal(JSON.parse(text.text).sections.keys.truncationReason, 'row_limit');
  } finally {
    await mcp.close();
  }
});

test('Oracle fallback preserves a visible target table when every target column is absent', async () => {
  const out = await run(async (q, accept) => {
    if (q.text.includes('FROM all_cons_columns') && !q.text.includes('table_name=:2')) return;
    await fixture()(q, accept);
  });
  assert.equal(out.rows.length, 3);
  assert(out.rows.every((row) => row[5] === 'Parent' && row[6] === null));
});
test('Oracle catalog read failures are propagated rather than converted to hidden or empty targets', async () => {
  await assert.rejects(
    run(async (q, accept) => {
      if (q.text.includes('FROM all_cons_columns') && !q.text.includes('table_name=:2'))
        throw Object.assign(new Error('fixture dictionary failure'), { code: 'ORA-01555' });
      await fixture()(q, accept);
    }),
    { code: 'ORA-01555' },
  );
});
