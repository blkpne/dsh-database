import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueryRunner } from '../../src/query.js';
import { connectionInput } from '../../src/schema.js';
import { connectDatabaseMcp } from '../../src/mcp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { harness } from '../harness.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { integrationTls } from './tls.js';

const configured = Boolean(
  process.env.DSH_DATABASE_TEST_USER && process.env.DSH_DATABASE_TEST_PASSWORD,
);
const config = connectionInput.parse({
  name: 'Integration',
  host: process.env.DSH_DATABASE_TEST_HOST || 'localhost',
  port: Number(process.env.DSH_DATABASE_TEST_PORT || 3306),
  user: process.env.DSH_DATABASE_TEST_USER || 'unused',
  database: process.env.DSH_DATABASE_TEST_DATABASE || '',
  tls: integrationTls(process.env, 'DSH_DATABASE_TEST_TLS'),
  maxRows: 2,
  timeoutMs: 400,
});
const password = async () => process.env.DSH_DATABASE_TEST_PASSWORD!;

test(
  'real MySQL: read-only SQL, schema discovery, analytics, exact caps, errors, abort and reconnect',
  { skip: !configured },
  async () => {
    const runner = new QueryRunner({ ...config, timeoutMs: 5000 }, password);
    try {
      const version = await runner.query('SELECT VERSION() AS version');
      console.log(`Verified server version: ${version.rows[0]?.[0]}`);
      assert.equal(version.rowCount, 1);
      assert((await runner.query('SHOW DATABASES')).rowCount > 0);
      const analytical = await runner.query(
        'WITH sample AS (SELECT 10 AS amount UNION ALL SELECT 20) SELECT SUM(amount) AS total, COUNT(*) AS count FROM sample',
      );
      assert.equal(Number(analytical.rows[0]?.[0]), 30);
      assert.equal(Number(analytical.rows[0]?.[1]), 2);
      const exact = await runner.query('SELECT 1 AS v UNION ALL SELECT 2');
      assert.equal(exact.truncated, false);
      const capped = await runner.query('SELECT 1 AS v UNION ALL SELECT 2 UNION ALL SELECT 3');
      assert.equal(capped.rowCount, 2);
      assert.equal(capped.truncated, true);
      const large = await runner.query("SELECT REPEAT('x', 100000) AS v");
      assert.equal(large.truncated, true);
      assert.equal(large.rowCount, 0);
      const precision = await runner.query(
        'SELECT CAST(9007199254740993 AS UNSIGNED) AS v, CAST(123.456 AS DECIMAL(10,3)) AS v',
      );
      assert.deepEqual(precision.columns, ['v', 'v']);
      assert.deepEqual(precision.rows[0], ['9007199254740993', '123.456']);
      await assert.rejects(runner.query('UPDATE imaginary SET x=1'), {
        code: 'READ_ONLY_VIOLATION',
      });
      await assert.rejects(runner.query('SELECT missing FROM information_schema.schemata'), {
        code: 'ER_BAD_FIELD_ERROR',
      });
      const controller = new AbortController();
      const delayed = runner.query('SELECT SLEEP(10)', controller.signal);
      setTimeout(() => controller.abort(), 100);
      await assert.rejects(delayed, { code: 'CANCELED' });
      assert.equal((await runner.query('SELECT 1')).rowCount, 1);
      const slow = runner.query('SELECT SLEEP(10)');
      setTimeout(() => runner.close(), 100);
      await assert.rejects(slow, { code: 'CANCELED' });
      await assert.rejects(runner.query('SELECT 1'), { code: 'CONNECTION_DISABLED' });
    } finally {
      runner.close();
    }
  },
);

test(
  'real MySQL timeout, bad password, concurrent query limit, actual MCP SQL call',
  { skip: !configured },
  async () => {
    const runner = new QueryRunner(config, password);
    try {
      await assert.rejects(runner.query('SELECT SLEEP(5)'), { code: 'TIMEOUT' });
      const bad = new QueryRunner(config, async () => 'deliberately-invalid-test-password');
      try {
        await assert.rejects(bad.query('SELECT 1'), { code: 'ER_ACCESS_DENIED_ERROR' });
      } finally {
        bad.close();
      }
      const a = runner.query('SELECT SLEEP(5)');
      const b = runner.query('SELECT SLEEP(5)');
      const settled = Promise.allSettled([a, b]);
      await assert.rejects(runner.query('SELECT 1'), { code: 'BUSY' });
      await settled;
      const mcp = await connectDatabaseMcp('Integration', (sql, signal) =>
        runner.query(sql, signal),
      );
      try {
        const result = CallToolResultSchema.parse(
          await mcp.client.callTool({ name: 'query', arguments: { sql: 'SELECT 42 AS answer' } }),
        );
        assert.equal(result.isError, undefined);
        assert.equal(Number((result.structuredContent?.rows as unknown[][])[0]?.[0]), 42);
      } finally {
        await mcp.close();
      }
    } finally {
      runner.close();
    }
  },
);

test(
  'actual DSH ToolRuntime -> MCP -> MySQL returns canonical JSON and rendered content',
  { skip: !configured },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-database-e2e-'));
    const app = await harness(directory);
    try {
      const saved = await app.api({
        action: 'save',
        connection: { ...config, password: await password() },
      });
      const record = saved.connections[0];
      await app.api({ action: 'toggle', id: record.id, revision: record.revision, enabled: true });
      const result = await app.ctx.tools.execute({
        name: record.toolName,
        callId: ToolCallId('e2e-query'),
        arguments: {
          sql: 'WITH x AS (SELECT 10 AS v UNION ALL SELECT 20) SELECT SUM(v) AS total FROM x',
        },
        signal: new AbortController().signal,
      });
      assert(!result.isError, JSON.stringify(result));
      assert.equal(Number((result.value as any).rows[0][0]), 30);
      assert.equal(result.content[0]?.type, 'text');
      assert(!JSON.stringify(result).includes(await password()));
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
