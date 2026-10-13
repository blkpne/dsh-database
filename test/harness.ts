import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import NodePtcRuntime from '@deepseek-ai/dsh-ptc-runtime-node';
import LocalFileSystem from '@deepseek-ai/dsh-fs-local';
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local';
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local';
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import Storage from '@deepseek-ai/dsh-storage';
import * as StorageJson from '@deepseek-ai/dsh-storage-json';
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain';
import Credentials from '@deepseek-ai/dsh-credentials-local';
import * as Connection from '@deepseek-ai/dsh-client-connection';
import * as Database from '../src/index.js';
import { join } from 'node:path';

export async function harness(
  directory: string,
  mode: 'native' | 'both' | 'ptc' = 'native',
  databasePlugin: typeof Database = Database,
) {
  const ctx = new Context();
  const fibers: { dispose(): Promise<void> }[] = [];
  // Actual Cordis providers: no fake tools, storage or credential service.
  for (const activate of [
    () => ctx.plugin(SystemPrompt, {}),
    ...(mode === 'native'
      ? []
      : [
          () => ctx.plugin(LocalFileSystem, { cwd: directory }),
          () => ctx.plugin(LocalSubprocess),
          () => ctx.plugin(LocalSandbox, {}),
          () => ctx.plugin(SessionProjections),
          () => ctx.plugin(SandboxPolicy, { mode: 'read-only', workspaceRoot: directory }),
          () => ctx.plugin(NodePtcRuntime, { timeoutMs: 5000 }),
        ]),
    () => ctx.plugin(ToolRuntime, { mode }),
    () => ctx.plugin(Storage),
    () => ctx.plugin(StorageJson, { root: join(directory, 'storage') }),
    () => ctx.plugin(StorageDomain, { backend: 'json' }),
    () => ctx.plugin(Credentials, { path: join(directory, 'credentials.yaml'), watch: false }),
    () => ctx.plugin(Connection, {}),
  ]) {
    const fiber = activate();
    fibers.push(fiber);
    await fiber.await();
  }
  const mount = async () => {
    const fiber = ctx.plugin(databasePlugin, { namespace: 'test' });
    await fiber.await();
    return fiber;
  };
  const plugin = await mount();
  fibers.push(plugin);
  return {
    ctx,
    plugin,
    mount,
    async api(payload: unknown) {
      const response = await ctx.connection.createSharedFetchHandler('/api').fetch(
        new Request('http://127.0.0.1/api/dsh-database', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }),
      );
      const data = (await response.json()) as any;
      if (!response.ok) throw Object.assign(new Error(data.message), { code: data.code });
      return data;
    },
    async close() {
      for (const fiber of fibers.reverse()) await fiber.dispose();
    },
  };
}
