import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueryRunner } from '../../src/query.js';
import { connectionInput, queryResult } from '../../src/schema.js';
import { connectDatabaseMcp } from '../../src/mcp.js';
import type { Engine } from '../../src/engines.js';
import { integrationTls } from './tls.js';

// Opt-in real servers. No fixture DDL, writes, shell commands, or embedded credentials.
for (const engine of ['mariadb', 'postgresql', 'sqlserver', 'oracle', 'mongodb'] as Engine[]) {
  const prefix = `DSH_DATABASE_${engine.toUpperCase()}_`;
  const env = (key: string) => process.env[`${prefix}${key}`];
  test(`real ${engine}: connection probe and MCP read`, { skip: !env('HOST') }, async () => {
    const config = connectionInput.parse({
      engine,
      name: 'Integration',
      host: env('HOST'),
      port: env('PORT') ? Number(env('PORT')) : undefined,
      user: env('USER') || '',
      database: env('DATABASE') || '',
      authSource: env('AUTH_SOURCE') || '',
      replicaSet: env('REPLICA_SET') || '',
      mongoSrv: env('SRV') === 'true',
      tls: integrationTls(process.env, `${prefix}TLS`),
      maxRows: 2,
      timeoutMs: 5000,
    });
    const runner = new QueryRunner(config, async () => env('PASSWORD') || '');
    const mcp = await connectDatabaseMcp(
      'Integration',
      (sql, signal) => runner.query(sql, signal),
      engine === 'mongodb' ? (query, signal) => runner.mongo(query, signal) : undefined,
    );
    try {
      const probe = await runner.test();
      assert.equal(probe.readOnly, true);
      const result = await mcp.client.callTool({
        name: 'query',
        arguments:
          engine === 'mongodb'
            ? { operation: 'find', collection: '_dsh_database_read_probe', limit: 1 }
            : { sql: engine === 'oracle' ? 'SELECT 1 AS n FROM DUAL' : 'SELECT 1 AS n' },
      });
      assert.equal(result.isError, undefined);
      assert(result.structuredContent);
      const structured = queryResult.parse(result.structuredContent);
      assert.equal(structured.readOnly, true);
      if (engine !== 'mongodb') assert.equal(Number(structured.rows[0]![0]), 1);
    } finally {
      await runner.close();
      await mcp.close();
    }
  });
}
