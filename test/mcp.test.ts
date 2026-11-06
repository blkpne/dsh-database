import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectDatabaseMcp } from '../src/mcp.js';
import { DatabaseError } from '../src/schema.js';
import { inspectInput, type InspectResult } from '../src/inspect.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

test('real MCP initialize, tools/list, tools/call, JSON output and invalid arguments', async () => {
  const connection = await connectDatabaseMcp('test', async (sql) => ({
    columns: ['sql'],
    rows: [[sql]],
    rowCount: 1,
    truncated: false,
    readOnly: true,
    durationMs: 0,
  }));
  try {
    const tools = await connection.client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      ['query'],
    );
    assert.equal(tools.tools[0]!.annotations?.readOnlyHint, true);
    const result = await connection.client.callTool({
      name: 'query',
      arguments: { sql: 'SELECT 1' },
    });
    assert.deepEqual(result.structuredContent, {
      columns: ['sql'],
      rows: [['SELECT 1']],
      rowCount: 1,
      truncated: false,
      readOnly: true,
      durationMs: 0,
    });
    const invalid = await connection.client.callTool({ name: 'query', arguments: { sql: 1 } });
    assert.equal(invalid.isError, true);
  } finally {
    await connection.close();
  }
});

test('MCP errors remain redacted and do not impersonate successful rows', async () => {
  const connection = await connectDatabaseMcp('test', async () => {
    throw { code: 'ER_PARSE_ERROR', message: 'sensitive SQL here' };
  });
  try {
    const result = CallToolResultSchema.parse(
      await connection.client.callTool({ name: 'query', arguments: { sql: 'invalid' } }),
    );
    assert.equal(result.isError, true);
    assert(!JSON.stringify(result).includes('sensitive'));
  } finally {
    await connection.close();
  }
});

test('MCP cancellation reaches the executor', async () => {
  let canceled = false;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const connection = await connectDatabaseMcp(
    'test',
    async (_sql, signal) =>
      new Promise((_, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            canceled = true;
            reject(new DatabaseError('CANCELED', 'cancelled'));
          },
          { once: true },
        );
        started();
      }),
  );
  try {
    const controller = new AbortController();
    const call = connection.client.callTool(
      { name: 'query', arguments: { sql: 'SELECT 1' } },
      undefined,
      { signal: controller.signal },
    );
    await ready;
    controller.abort();
    await assert.rejects(call);
    await new Promise((resolve) => setImmediate(resolve));
    assert(canceled);
  } finally {
    await connection.close();
  }
});

test('closing the public MCP bridge cancels and awaits executor cleanup exactly once', async () => {
  let entered!: () => void, cleaned!: () => void;
  const ready = new Promise<void>((r) => {
    entered = r;
  });
  const cleanup = new Promise<void>((r) => {
    cleaned = r;
  });
  let canceled = false;
  const connection = await connectDatabaseMcp('fixture', async (_sql, signal) => {
    entered();
    try {
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => {
            canceled = true;
            reject(new Error('aborted'));
          },
          { once: true },
        ),
      );
      throw new Error('unreachable');
    } finally {
      await cleanup;
    }
  });
  const call = assert.rejects(
    connection.client.callTool({ name: 'query', arguments: { sql: 'SELECT 1' } }),
  );
  await ready;
  const closing = connection.close();
  assert.equal(closing, connection.close());
  let finished = false;
  void closing.then(() => {
    finished = true;
  });
  await new Promise((r) => setImmediate(r));
  assert(canceled);
  assert.equal(finished, false);
  cleaned();
  await Promise.all([call, closing]);
});

test('malformed executor output is redacted before SDK output validation', async () => {
  const connection = await connectDatabaseMcp('fixture', async () => ({
    columns: [],
    rows: [],
    rowCount: -1,
    truncated: false,
    readOnly: true,
    durationMs: 0,
  }));
  try {
    const response = await connection.client.callTool({
      name: 'query',
      arguments: { sql: 'SELECT 1' },
    });
    assert.equal(response.isError, true);
    assert.equal(response.structuredContent, undefined);
  } finally {
    await connection.close();
  }
});

// Assert the public MCP contract, not just the source declaration: query selects
// a different input schema for SQL and MongoDB, while inspect adds refinements.
for (const engine of ['sql', 'mongodb'] as const) {
  test(`MCP tools/list exports complete ${engine} query and inspect input schemas`, async () => {
    const query = async () => ({
      columns: [],
      rows: [],
      rowCount: 0,
      truncated: false,
      readOnly: true as const,
      durationMs: 0,
    });
    const inspect = async (): Promise<InspectResult> => ({
      action: 'capabilities',
      engine,
      sections: {},
      nextOffset: null,
      cache: { hit: false, ageMs: 0, ttlMs: 0 },
      durationMs: 0,
      readOnly: true,
    });
    const connection = await connectDatabaseMcp(
      'schema fixture',
      query,
      engine === 'mongodb' ? query : undefined,
      { inspect },
    );
    try {
      const { tools } = await connection.client.listTools();
      assert.deepEqual(
        tools.map((tool) => tool.name),
        ['query', 'inspect'],
      );
      for (const tool of tools) {
        assert.equal(tool.inputSchema.type, 'object');
        assert.equal(tool.inputSchema.additionalProperties, false);
        assert(Object.keys(tool.inputSchema.properties ?? {}).length > 0);
      }
      const querySchema = tools[0]!.inputSchema;
      if (engine === 'sql') {
        assert.deepEqual(querySchema.required, ['sql']);
        assert.deepEqual(querySchema.properties?.sql, {
          type: 'string',
          minLength: 1,
          maxLength: 32768,
        });
        assert.equal(querySchema.properties?.operation, undefined);
      } else {
        assert.deepEqual(querySchema.required, ['operation']);
        assert.deepEqual(querySchema.properties?.operation, {
          type: 'string',
          enum: ['listCollections', 'find', 'aggregate', 'count'],
        });
        assert.equal(querySchema.properties?.sql, undefined);
        assert(querySchema.properties?.pipeline);
      }
      const inspectSchema = tools[1]!.inputSchema;
      assert.deepEqual(inspectSchema.required, ['action']);
      assert.deepEqual(inspectSchema.properties?.action, {
        type: 'string',
        enum: ['capabilities', 'namespaces', 'search', 'describe'],
      });
      assert.deepEqual(inspectSchema.properties?.limit, {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        default: 30,
      });
    } finally {
      await connection.close();
    }
  });
}

test('MCP rejects invalid SQL and inspect inputs before invoking callbacks', async () => {
  let queryCalls = 0;
  let inspectCalls = 0;
  let inspected: unknown;
  const connection = await connectDatabaseMcp(
    'schema fixture',
    async () => {
      queryCalls++;
      return {
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        readOnly: true,
        durationMs: 0,
      };
    },
    undefined,
    {
      inspect: async (input) => {
        inspectCalls++;
        inspected = input;
        return {
          action: 'capabilities',
          engine: 'postgresql',
          sections: {},
          nextOffset: null,
          cache: { hit: false, ageMs: 0, ttlMs: 0 },
          durationMs: 0,
          readOnly: true,
        };
      },
    },
  );
  try {
    const invalidSql = [
      {},
      { sql: 1 },
      { sql: '' },
      { sql: 'x'.repeat(32769) },
      { sql: 'SELECT 1', extra: true },
    ];
    for (const args of invalidSql) {
      assert.equal(
        (await connection.client.callTool({ name: 'query', arguments: args })).isError,
        true,
      );
    }
    const invalidInspect = [
      {},
      { action: 'drop' },
      { action: 'describe' },
      { action: 'search', limit: 101 },
      { action: 'search', limit: 1.5 },
      { action: 'search', offset: -1 },
      { action: 'search', refresh: 'true' },
      { action: 'search', name: 'x'.repeat(129) },
      { action: 'capabilities', sql: 'SELECT 1' },
    ];
    for (const args of invalidInspect) {
      assert.equal(
        (await connection.client.callTool({ name: 'inspect', arguments: args })).isError,
        true,
      );
    }
    assert.equal(queryCalls, 0);
    assert.equal(inspectCalls, 0);
    assert.notEqual(
      (
        await connection.client.callTool({
          name: 'inspect',
          arguments: { action: 'capabilities' },
        })
      ).isError,
      true,
    );
    assert.equal(inspectCalls, 1);
    assert.deepEqual(inspected, inspectInput.parse({ action: 'capabilities' }));
  } finally {
    await connection.close();
  }
});

test('MCP rejects invalid MongoDB inputs and unsafe operations before executor dispatch', async () => {
  let calls = 0;
  const connection = await connectDatabaseMcp(
    'schema fixture',
    async () => {
      assert.fail('MongoDB tool must not dispatch to the SQL executor');
    },
    async () => {
      calls++;
      return {
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        readOnly: true,
        durationMs: 0,
      };
    },
  );
  try {
    const invalid = [
      {},
      { sql: 'SELECT 1' },
      { operation: 'deleteMany', collection: 'items' },
      { operation: 'find' },
      { operation: 'find', collection: 'items', limit: 5001 },
      { operation: 'find', collection: 'items', extra: true },
      { operation: 'find', collection: 'items', filter: { $where: 'return true' } },
      { operation: 'aggregate', collection: 'items', pipeline: [{ $out: 'other' }] },
    ];
    for (const args of invalid) {
      assert.equal(
        (await connection.client.callTool({ name: 'query', arguments: args })).isError,
        true,
      );
    }
    assert.equal(calls, 0);
    assert.notEqual(
      (
        await connection.client.callTool({
          name: 'query',
          arguments: { operation: 'find', collection: 'items', limit: 1 },
        })
      ).isError,
      true,
    );
    assert.equal(calls, 1);
  } finally {
    await connection.close();
  }
});
