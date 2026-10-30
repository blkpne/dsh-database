import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ToolExecution, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { scopeChainOf, createScope } from '@deepseek-ai/dsh-scope';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { queryResult, sqlInput, DatabaseError, safeError } from './schema.js';
import { inspectInput, inspectResult } from './inspect.js';
import { mongoInput } from './mongo.js';
import { toolName } from './manager.js';
import type { MountTool } from './ports.js';
import { connectDatabaseMcp } from './mcp.js';
import { engines } from './engines.js';
import { effectivePolicy, OwnerBudgets } from './policy.js';
import { Observatory, callContext, stage } from './observability.js';
import type { Trace } from './observability.js';
import { inspectGuidance, queryGuidance } from './tool-guidance.js';

/** Public scoped registrations hide unauthorized tools; guards and executors enforce the same policy. */
export function mountDatabaseTool(ctx: Context, observations = new Observatory()): MountTool {
  // Budget state survives per-connection policy revisions during this plugin lifetime.
  const budget = new OwnerBudgets();
  const traces = new Map<symbol, Trace>();
  const owners = new Map<string, (exec: ToolExecution) => Trace>();
  ctx.on('tools/result', (exec, result) => {
    const trace = traces.get(exec.token) ?? owners.get(exec.name)?.(exec);
    if (!trace) return;
    observations.finish(
      trace,
      result.isError ? (trace.code ?? result.error.info?.code ?? 'HOST_REJECTED') : undefined,
      true,
    );
    traces.delete(exec.token);
  });
  return async (record, runner) => {
    const policy = effectivePolicy(record.policy);
    const description = `Read-only ${engines[record.engine].label} connection ${JSON.stringify(record.name)}. Metadata tool: mcp__dshdb_${record.id}__inspect. Max ${record.maxRows} rows, ${record.timeoutMs} ms.${record.engine === 'sqlserver' ? ' CAST decimal/numeric/money AS varchar(100) to preserve precision.' : ''}`;
    const mongo = record.engine === 'mongodb';
    const names = new Set([toolName(record.id), `mcp__dshdb_${record.id}__inspect`]);
    const disposers: (() => void)[] = [];
    const cleanup: (() => Promise<unknown>)[] = [];
    const pending = new Map<string, Promise<unknown>>();
    function owned<T>(operation: () => Promise<T>): Promise<T> {
      const trace = callContext.getStore();
      const promise = Promise.resolve().then(operation);
      if (trace) {
        pending.set(trace.requestId, promise);
        void promise
          .finally(() => {
            if (pending.get(trace.requestId) === promise) pending.delete(trace.requestId);
          })
          .catch(() => {});
      }
      return promise;
    }
    let retired = false;
    function identity(exec: ToolExecution) {
      const chain = scopeChainOf(exec.agent);
      const registry = ctx.get('agents');
      const agents = registry?.list() ?? [];
      const owners = chain.filter((key): key is Agent => agents.includes(key as Agent));
      const allowed =
        policy.access === 'host' || owners.some((agent) => policy.sessionIds.includes(agent.id));
      return { allowed, owner: owners.at(-1)?.id ?? exec.agent?.id ?? 'host-transport' };
    }
    function begin(exec: ToolExecution): Trace {
      const existing = traces.get(exec.token);
      if (existing) return existing;
      const who = identity(exec);
      const trace = observations.start({
        connectionId: record.id,
        revision: record.revision,
        operation: exec.name.endsWith('__inspect') ? 'inspect' : 'query',
        callId: exec.callId,
        rootCallId: exec.rootCallId,
        agentId: exec.agent?.id,
        ownerId: who.owner,
      });
      traces.set(exec.token, trace);
      return trace;
    }
    function authorize(exec: ToolExecution, charge: boolean): void {
      if (retired) throw new DatabaseError('CONNECTION_DISABLED', '连接已停用。');
      const who = identity(exec);
      if (!who.allowed) throw new DatabaseError('POLICY_DENIED', '当前会话未获此连接授权。');
      if (policy.mode === 'metadata' && exec.name.endsWith('__query'))
        throw new DatabaseError('POLICY_DENIED', '此连接只允许结构发现。');
      if (charge) budget.take(`${record.id}/${who.owner}`, policy);
    }
    const mcp = await connectDatabaseMcp(
      description,
      (sql, signal) => owned(() => runner.query(sql, signal)),
      mongo ? (input, signal) => owned(() => runner.mongo(input, signal)) : undefined,
      {
        metadataOnly: policy.mode === 'metadata',
        inspect: runner.inspect
          ? (input, signal) =>
              owned(() => runner.inspect!(input, signal, callContext.getStore()?.ownerId))
          : undefined,
        authorize() {
          if (retired || !callContext.getStore())
            throw new DatabaseError('POLICY_DENIED', 'MCP 调用缺少可信宿主上下文。');
        },
      },
    );
    async function execute(
      kind: 'query' | 'inspect',
      args: Record<string, unknown>,
      exec: ToolRunContext,
    ) {
      const hadTrace = traces.has(exec.token);
      const trace = begin(exec);
      return callContext.run(trace, async () => {
        let dispatched = false;
        try {
          authorize(exec, !hadTrace);
          const validated =
            kind === 'inspect'
              ? inspectInput.parse(args)
              : mongo
                ? mongoInput.parse(args)
                : sqlInput.parse(args);
          stage('mcp-dispatch');
          dispatched = true;
          const result = CallToolResultSchema.parse(
            await mcp.client.callTool({ name: kind, arguments: validated }, undefined, {
              signal: exec.signal,
              timeout: record.timeoutMs + 2000,
            }),
          );
          if (result.isError) {
            const text = result.content.find((c) => c.type === 'text');
            let failure = {
              code: 'MCP_ERROR',
              message: '数据库工具未返回有效结果，请检查参数或重新发起。',
            };
            // The SDK may return plain text before our callback runs. Never parse blindly,
            // or forward protocol/driver text which may echo submitted values.
            if (text?.type === 'text') {
              try {
                const value = JSON.parse(text.text);
                if (
                  value &&
                  typeof value.code === 'string' &&
                  /^[A-Z0-9_-]{1,64}$/.test(value.code) &&
                  typeof value.message === 'string'
                )
                  failure = { code: value.code, message: value.message };
              } catch {
                /* Safe protocol fallback above. */
              }
            }
            throw new DatabaseError(failure.code, failure.message);
          }
          const value =
            kind === 'inspect'
              ? inspectResult.parse(result.structuredContent)
              : queryResult.parse(result.structuredContent);
          if ('cache' in value) trace.cacheHit = value.cache.hit;
          observations.finish(trace);
          return value;
        } catch (error) {
          // MCP abort/transport close can reject before the executor has finished cleanup.
          // Await only this call, never another owner's work, before finalizing its evidence.
          await pending.get(trace.requestId)?.catch(() => {});
          const safe =
            dispatched && (retired || exec.signal.aborted)
              ? { code: 'CANCELED', message: '调用已取消，请查看驱动清理状态。' }
              : safeError(error);
          observations.finish(trace, safe.code);
          throw new DatabaseError(
            safe.code,
            `${safe.code}: ${safe.message} 请求编号：${trace.requestId}`,
          );
        }
      });
    }
    try {
      const definitions: ToolDefinition[] = [];
      if (policy.mode !== 'metadata')
        definitions.push(
          defineTool({
            name: toolName(record.id),
            description: `${description} ${queryGuidance(mongo)}`,
            parameters: mongo
              ? {
                  operation: {
                    type: 'string',
                    required: true,
                    enum: ['listCollections', 'find', 'aggregate', 'count'],
                    description: 'Read-only MongoDB operation.',
                  },
                  collection: {
                    type: 'string',
                    description: 'Required except for listCollections.',
                  },
                  filter: {
                    type: 'json',
                    description: 'MongoDB filter object; Extended JSON v2 supported.',
                  },
                  projection: {
                    type: 'json',
                    description: 'Field names mapped to 0 or 1 for find.',
                  },
                  sort: { type: 'json', description: 'Field names mapped to 1 or -1 for find.' },
                  pipeline: {
                    type: 'json',
                    description: 'Array of read-only aggregation stages; no writes or JavaScript.',
                  },
                  limit: {
                    type: 'integer',
                    description:
                      'Optional find/aggregate row cap, 1–5000; bounded by connection settings.',
                  },
                }
              : {
                  sql: {
                    type: 'string',
                    required: true,
                    description: `One read-only ${engines[record.engine].label} SQL statement.`,
                  },
                },
            output: {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  columns: { type: 'array', items: { type: 'string' }, required: true },
                  rows: {
                    type: 'array',
                    items: { type: 'array', items: { type: 'json' } },
                    required: true,
                  },
                  rowCount: { type: 'integer', required: true },
                  truncated: { type: 'boolean', required: true },
                  truncationReason: {
                    type: 'string',
                    enum: ['row_limit', 'byte_limit', 'cell_limit', 'unsupported_value'],
                  },
                  durationMs: { type: 'number', required: true },
                  readOnly: { type: 'boolean', required: true },
                },
              },
              render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
            },
            execute: async (args, exec) => queryResult.parse(await execute('query', args, exec)),
          }),
        );
      if (runner.inspect)
        definitions.push(
          defineTool({
            name: `mcp__dshdb_${record.id}__inspect`,
            description: `Inspect ${engines[record.engine].label} connection ${JSON.stringify(record.name)}. ${inspectGuidance}`,
            parameters: {
              action: {
                type: 'string',
                enum: ['capabilities', 'namespaces', 'search', 'describe'],
                required: true,
              },
              name: {
                type: 'string',
                description: 'Literal name fragment for search; exact name for describe.',
              },
              schema: { type: 'string', description: 'Schema/owner; omit for current default.' },
              catalog: {
                type: 'string',
                description: 'Database catalog; only MySQL/MariaDB support switching.',
              },
              type: { type: 'string', enum: ['table', 'view', 'collection'] },
              limit: { type: 'integer', description: 'Search page size, 1–100, default 30.' },
              offset: { type: 'integer', description: 'Search offset, default 0; use nextOffset.' },
              refresh: {
                type: 'boolean',
                description: 'Bypass the bounded 60-second metadata cache.',
              },
            },
            output: {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  action: { type: 'string', required: true },
                  engine: { type: 'string', required: true },
                  capabilities: { type: 'json' },
                  sections: { type: 'object', additionalProperties: true, required: true },
                  nextOffset: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
                  cache: { type: 'object', additionalProperties: true, required: true },
                  durationMs: { type: 'number', required: true },
                  readOnly: { type: 'boolean', required: true },
                },
              },
              render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
            },
            execute: async (args, exec) =>
              inspectResult.parse(await execute('inspect', args, exec)),
          }),
        );
      disposers.push(
        ctx.tools.guard((exec) => {
          if (!names.has(exec.name)) return;
          const trace = begin(exec);
          trace.stages.push({ name: 'policy', atMs: Date.now() - trace.startedAt });
          try {
            authorize(exec, true);
          } catch (error) {
            const safe = safeError(error);
            observations.finish(trace, safe.code);
            return `${safe.code}: ${safe.message} 请求编号：${trace.requestId}`;
          }
        }),
      );
      for (const name of names) owners.set(name, begin);
      disposers.push(() => {
        for (const name of names) if (owners.get(name) === begin) owners.delete(name);
      });
      if (policy.access === 'host') {
        for (const definition of definitions) disposers.push(ctx.tools.register(definition));
      } else {
        const registry = ctx.get('agents');
        if (!registry)
          throw new DatabaseError(
            'SCOPE_UNAVAILABLE',
            '宿主未提供可信会话作用域，无法启用会话授权连接。',
          );
        const mounted = new Map<
          Agent,
          { unregister: (() => void)[]; dispose: () => Promise<void> }
        >();
        const retiring = new Set<Promise<void>>();
        cleanup.push(() => Promise.all([...retiring]));
        const retireScope = (dispose: () => Promise<void>) => {
          const pending = dispose();
          retiring.add(pending);
          void pending.finally(() => retiring.delete(pending)).catch(() => {});
        };
        const remove = (agent: Agent) => {
          const registration = mounted.get(agent);
          if (!registration) return;
          mounted.delete(agent);
          registration.unregister.forEach((dispose) => dispose());
          retireScope(registration.dispose);
        };
        // Own every partial registration before the initial agent loop can fail.
        disposers.push(() => {
          for (const agent of mounted.keys()) remove(agent);
        });
        const add = (agent: Agent) => {
          if (policy.sessionIds.includes(agent.id) && !mounted.has(agent)) {
            const scope = createScope(ctx, agent);
            try {
              mounted.set(agent, {
                unregister: definitions.map((def) => scope.ctx.tools.register(def)),
                dispose: () => scope.dispose(),
              });
            } catch (error) {
              retireScope(() => scope.dispose());
              throw error;
            }
          }
        };
        for (const agent of registry.list()) add(agent);
        disposers.push(
          ctx.on('agent/created', ({ agent }) => {
            add(agent);
            return undefined;
          }),
        );
        disposers.push(ctx.on('agent/disposed', ({ agent }) => remove(agent)));
      }
      return async () => {
        retired = true;
        disposers.reverse().forEach((dispose) => dispose());
        await Promise.all([mcp.close(), ...cleanup.map((dispose) => dispose())]);
      };
    } catch (error) {
      retired = true;
      disposers.reverse().forEach((dispose) => dispose());
      await Promise.allSettled([mcp.close(), ...cleanup.map((dispose) => dispose())]);
      throw error;
    }
  };
}
