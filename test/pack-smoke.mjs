import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import Storage from '@deepseek-ai/dsh-storage';
import * as StorageJson from '@deepseek-ai/dsh-storage-json';
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain';
import Credentials from '@deepseek-ai/dsh-credentials-local';
import * as Connection from '@deepseek-ai/dsh-client-connection';
import * as Database from 'dsh-database';
import { connectDatabaseMcp } from 'dsh-database/mcp';

const require = createRequire(import.meta.url);
const pkg = require('dsh-database/package.json');
assert.equal(pkg.license, 'MIT');
const ctx = new Context();
const fibers = [];
const mount = async (plugin, config) => {
  const fiber = ctx.plugin(plugin, config);
  fibers.push(fiber);
  await fiber.await();
  return fiber;
};
const api = async (body) => {
  const response = await ctx.connection.createSharedFetchHandler('/api').fetch(
    new Request('http://127.0.0.1/api/dsh-database', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    ctx.connection.browserPeer,
  );
  assert.equal(response.status, 200);
  return response.json();
};
try {
  await mount(SystemPrompt, {});
  await mount(ToolRuntime, { mode: 'native' });
  await mount(Storage);
  await mount(StorageJson, { root: join(process.cwd(), 'storage') });
  await mount(StorageDomain, { backend: 'json' });
  await mount(Credentials, { path: join(process.cwd(), 'credentials.yaml'), watch: false });
  await mount(Connection, {});
  const plugin = await mount(Database, { namespace: 'pack' });
  assert.deepEqual((await api({ action: 'list' })).connections, []);
  let record = (
    await api({
      action: 'save',
      connection: { name: 'Isolated package smoke', host: '127.0.0.1', user: 'unused' },
    })
  ).connections[0];
  assert.equal(ctx.tools.schemas().length, 0);
  record = (
    await api({ action: 'toggle', id: record.id, revision: record.revision, enabled: true })
  ).connections[0];
  assert.equal(record.status, 'enabled');
  const call = (name, args) =>
    ctx.tools.execute({
      name,
      callId: `pack-${name}`,
      arguments: args,
      signal: new AbortController().signal,
    });
  const result = await call(record.inspectToolName, { action: 'capabilities' });
  assert.equal(result.isError, false);
  assert(JSON.stringify(result).includes('MySQL'));
  const denied = await call(record.toolName, { sql: 'DELETE FROM forbidden' });
  assert.equal(denied.isError, true);
  assert(JSON.stringify(denied).includes('READ_ONLY_VIOLATION'));
  await plugin.dispose();
  assert.equal(ctx.tools.schemas().length, 0);
  await mount(Database, { namespace: 'pack' });
  assert.equal((await api({ action: 'list' })).connections[0].id, record.id);
  assert.equal(ctx.tools.schemas().length, 2);
  await api({ action: 'remove', id: record.id, revision: record.revision });
  assert.equal(ctx.tools.schemas().length, 0);
} finally {
  for (const fiber of fibers.reverse()) await fiber.dispose();
}

const mcp = await connectDatabaseMcp('Package protocol smoke', async () => ({
  columns: ['value'],
  rows: [[42]],
  rowCount: 1,
  truncated: false,
  readOnly: true,
  durationMs: 0,
}));
try {
  assert.equal(mcp.client.getServerVersion().version, pkg.version);
  assert.deepEqual(
    (await mcp.client.callTool({ name: 'query', arguments: { sql: 'SELECT 42' } }))
      .structuredContent.rows,
    [[42]],
  );
} finally {
  await mcp.close();
}
let clientModule;
runInNewContext(readFileSync(require.resolve('dsh-database/client'), 'utf8'), {
  window: {
    __ModuleLoader__: {
      load(value) {
        clientModule = value;
      },
    },
  },
});
assert.equal(clientModule.id, pkg.name);
assert.equal(typeof clientModule.factory(require).apply, 'function');
console.log(
  'Tarball: Host activation, MCP call/version, write denial, persistence, unload/reload and Client factory passed. No database server or browser was simulated as passed.',
);
