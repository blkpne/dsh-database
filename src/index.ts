import type { Context } from '@deepseek-ai/cordis';
import s from '@deepseek-ai/schemastery';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import type {} from '@deepseek-ai/dsh-client-connection';
import { connectionRecord, DatabaseError } from './schema.js';
import { ConnectionManager } from './manager.js';
import { mountDatabaseTool } from './bridge.js';
import { runtimeLimits, type RuntimeLimits } from './limits.js';
import { handleApi } from './api.js';
import { Observatory, traceRecord } from './observability.js';

export const name = 'dsh-database';
export const inject = ['tools', 'storageDomain', 'credentials'];
export const Config = s.object({
  namespace: s
    .string()
    .pattern(/^[a-z][a-z0-9_]{0,31}$/)
    .default('default'),
  maxConcurrentQueries: s.natural().min(1).max(40).default(8),
  maxQueriesPerConnection: s.natural().min(1).max(8).default(2),
  maxPendingMutations: s.natural().min(1).max(128).default(32),
});

export async function apply(
  ctx: Context,
  config: { namespace: string } & Partial<RuntimeLimits>,
): Promise<void> {
  runtimeLimits.parse(config);
  const domain = await ctx.storageDomain.open(
    defineDomain({
      name: `dsh_database_${config.namespace}`,
      version: 1,
      tables: { connections: domainTable(connectionRecord) },
    }),
  );
  const journal = await ctx.storageDomain
    .open(
      defineDomain({
        name: `dsh_database_${config.namespace}_operations`,
        version: 1,
        tables: { traces: domainTable(traceRecord) },
      }),
    )
    .catch(async (error: unknown) => {
      // Domain handles belong to this consumer, including partially initialized instances.
      await domain.close();
      throw error;
    });
  const observations = new Observatory(journal.table('traces'));
  const manager = new ConnectionManager(
    domain.table('connections'),
    {
      async read(ref) {
        const secret = await ctx.credentials.resolve(credentialRef(ref));
        if (!secret)
          throw new DatabaseError(
            'MISSING_PASSWORD',
            '保存的密码不可用，请重新编辑连接并填写密码。',
          );
        return secret.value;
      },
      set: (ref, value) => ctx.credentials.set(credentialRef(ref), value),
      delete: (ref) => ctx.credentials.unset(credentialRef(ref)),
    },
    mountDatabaseTool(ctx, observations),
    config,
    undefined,
    observations,
  );
  manager.scopeChoices = () =>
    ctx
      .get('agents')
      ?.list()
      .map((agent) => ({
        id: agent.id,
        workspace: agent.session.header?.cwd,
        createdAt: agent.session.header?.createdAt,
        child: agent.session.header?.origin === 'subagent',
      })) ?? [];
  ctx.effect(
    () => async () => {
      try {
        await manager.close();
      } finally {
        await Promise.all([domain.close(), journal.close()]);
      }
    },
    'dsh-database.lifecycle',
  );
  await manager.restore();
  ctx.inject(['connection'], (web) => {
    web.effect(
      () =>
        web.connection.fetch.register({
          path: '/api/dsh-database',
          methods: ['POST'],
          requestBody: 'streaming',
          fetch: (request) => handleApi(manager, request),
        }),
      'dsh-database.api',
    );
  });
}
