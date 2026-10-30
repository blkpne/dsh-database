import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { DatabaseError, queryResult, safeError, sqlInput } from './schema.js';
import type { QueryResult } from './schema.js';
import { mongoInput, validateMongoQuery } from './mongo.js';
import type { MongoQuery } from './mongo.js';
import { inspectInput, inspectResult } from './inspect.js';
import type { InspectResult } from './inspect.js';
import { inspectGuidance, queryGuidance } from './tool-guidance.js';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export interface McpOptions {
  inspect?: (input: unknown, signal: AbortSignal) => Promise<InspectResult>;
  metadataOnly?: boolean;
  /** A transport owner supplies this trusted gate; never derive identity from tool arguments. */
  authorize?: () => void;
}

export type QueryExecutor = (sql: string, signal: AbortSignal) => Promise<QueryResult>;
export type MongoExecutor = (input: MongoQuery, signal: AbortSignal) => Promise<QueryResult>;

/** Own callback cleanup even when this factory is used without a QueryRunner/DSH host. */
class DatabaseServer extends McpServer {
  private active = new Map<AbortController, Promise<void>>();
  private closing?: Promise<void>;
  private closed = false;

  async run<T>(parent: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) throw new DatabaseError('CLOSED', 'MCP 通道已关闭。');
    const controller = new AbortController();
    let done!: () => void;
    this.active.set(
      controller,
      new Promise<void>((resolve) => {
        done = resolve;
      }),
    );
    try {
      const signal = AbortSignal.any([parent, controller.signal]);
      signal.throwIfAborted();
      return await operation(signal);
    } finally {
      this.active.delete(controller);
      done();
    }
  }

  override close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const controller of this.active.keys()) controller.abort();
    this.closing = (async () => {
      const outcomes = await Promise.allSettled([super.close(), ...this.active.values()]);
      const failed = outcomes.find((outcome) => outcome.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    })();
    return this.closing;
  }
}

/** Public factory also accepts a caller-owned standard stdio/HTTP MCP transport. */
export function createDatabaseServer(
  description: string,
  execute: QueryExecutor,
  mongo?: MongoExecutor,
  options: McpOptions = {},
): McpServer {
  const server = new DatabaseServer({ name: 'dsh-database', version });
  if (!options.metadataOnly)
    server.registerTool(
      'query',
      {
        title: 'Read-only database query',
        description: `${description} ${queryGuidance(!!mongo)}`,
        inputSchema: mongo ? mongoInput : sqlInput,
        outputSchema: queryResult,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (args: unknown, extra: { signal: AbortSignal }) => {
        try {
          options.authorize?.();
          const result = queryResult.parse(
            await server.run(extra.signal, (signal) =>
              mongo
                ? mongo(validateMongoQuery(args), signal)
                : execute(sqlInput.parse(args).sql, signal),
            ),
          );
          return {
            structuredContent: result,
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          };
        } catch (error) {
          const safe = safeError(error);
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify(safe) }],
          };
        }
      },
    );
  if (options.inspect)
    server.registerTool(
      'inspect',
      {
        title: 'Inspect database capabilities and structure',
        description: inspectGuidance,
        inputSchema: inspectInput,
        outputSchema: inspectResult,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (args, extra) => {
        try {
          options.authorize?.();
          const result = inspectResult.parse(
            await server.run(extra.signal, (signal) => options.inspect!(args, signal)),
          );
          return {
            structuredContent: result,
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          };
        } catch (error) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify(safeError(error)) }],
          };
        }
      },
    );
  return server;
}

export async function connectDatabaseMcp(
  description: string,
  execute: QueryExecutor,
  mongo?: MongoExecutor,
  options: McpOptions = {},
) {
  const server = createDatabaseServer(description, execute, mongo, options);
  const client = new Client({ name: 'dsh-database-bridge', version });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const closePair = async () => {
    const outcomes = await Promise.allSettled([client.close(), server.close()]);
    const failed = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  };
  try {
    await server.connect(serverTransport as Transport);
    await client.connect(clientTransport as Transport);
    const { tools } = await client.listTools();
    const expected = [!options.metadataOnly && 'query', options.inspect && 'inspect'].filter(
      Boolean,
    );
    if (JSON.stringify(tools.map((tool) => tool.name)) !== JSON.stringify(expected))
      throw new Error('Unexpected MCP tool list');
    return {
      client,
      server,
      close: (() => {
        let closing: Promise<void> | undefined;
        return () => (closing ??= closePair());
      })(),
    };
  } catch (error) {
    await closePair().catch(() => {});
    throw error;
  }
}
