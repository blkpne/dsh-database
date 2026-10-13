import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectDatabaseMcp } from '../src/mcp.js';
import { DatabaseError } from '../src/schema.js';
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
