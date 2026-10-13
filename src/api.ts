import { z } from 'zod';
import { DatabaseError, safeError } from './schema.js';
import { CommittedMutationError, type ConnectionManager } from './manager.js';

const id = z.string().regex(/^[a-f0-9]{16}$/);
const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('scopes') }).strict(),
  z.object({ action: z.literal('observations'), id }).strict(),
  z.object({ action: z.literal('diagnose'), id, revision: z.number().int().positive() }).strict(),
  z
    .object({
      action: z.literal('save'),
      connection: z.unknown(),
      id: id.optional(),
      revision: z.number().int().positive().optional(),
    })
    .strict(),
  z.object({ action: z.literal('test'), connection: z.unknown(), id: id.optional() }).strict(),
  z
    .object({
      action: z.literal('toggle'),
      id,
      enabled: z.boolean(),
      revision: z.number().int().positive(),
    })
    .strict(),
  z.object({ action: z.literal('remove'), id, revision: z.number().int().positive() }).strict(),
]);
const respond = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });

/** Mounted below the authenticated host /api carrier, never as an unguarded web route. */
export async function handleApi(manager: ConnectionManager, request: Request): Promise<Response> {
  if (request.method !== 'POST') return respond({ ok: false, message: 'Method not allowed' }, 405);
  if (
    !request.headers
      .get('content-type')
      ?.split(';')[0]
      ?.trim()
      .toLowerCase()
      .match(/^application\/json$/)
  )
    return respond({ ok: false, message: 'JSON required' }, 415);
  try {
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 16384) {
            await reader.cancel();
            throw new DatabaseError('TOO_LARGE', '请求体超过 16 KiB。');
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    let json: unknown;
    try {
      json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new DatabaseError('INVALID_INPUT', '请求 JSON 格式不正确。');
    }
    const input = requestSchema.parse(json);
    switch (input.action) {
      case 'scopes':
        return respond({ ok: true, scopes: manager.scopeChoices() });
      case 'observations':
        return respond({ ok: true, observations: manager.observations.snapshot(input.id) });
      case 'diagnose':
        return respond({
          ok: true,
          ...(await manager.diagnose(input.id, input.revision, request.signal)),
        });
      case 'list':
        return respond({ ok: true, connections: manager.list() });
      case 'save':
        return respond({
          ok: true,
          ...(await manager.save(input.connection, input.id, input.revision)),
        });
      case 'test':
        return respond({
          ok: true,
          result: await manager.test(input.connection, input.id, request.signal),
        });
      case 'toggle':
        return respond({
          ok: true,
          connections: await manager.toggle(input.id, input.enabled, input.revision),
        });
      case 'remove':
        return respond({ ok: true, connections: await manager.remove(input.id, input.revision) });
    }
  } catch (error) {
    const safe = safeError(error);
    return respond(
      {
        ok: false,
        ...safe,
        ...(error instanceof CommittedMutationError
          ? { committed: true, connectionId: error.connectionId, connections: error.connections }
          : {}),
      },
      ({ CONFLICT: 409, TOO_LARGE: 413, BUSY: 429, CLOSED: 503 } as Record<string, number>)[
        safe.code
      ] ?? 400,
    );
  }
}
