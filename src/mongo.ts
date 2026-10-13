import { z } from 'zod';
import { DatabaseError } from './errors.js';
import { assertJsonInput } from './json-input.js';

const object = z.record(z.string(), z.unknown());
export const mongoInput = z
  .object({
    operation: z.enum(['listCollections', 'find', 'aggregate', 'count']),
    collection: z.string().min(1).max(255).optional(),
    filter: object.optional(),
    projection: z.record(z.string(), z.union([z.literal(0), z.literal(1)])).optional(),
    sort: z.record(z.string(), z.union([z.literal(-1), z.literal(1)])).optional(),
    pipeline: z.array(object).max(40).optional(),
    limit: z.number().int().min(1).max(5000).optional(),
  })
  .strict();
export type MongoQuery = z.infer<typeof mongoInput>;

// No command passthrough; nested expression and pipeline validation prevents JS and writes.
const stages = new Set([
  '$match',
  '$project',
  '$group',
  '$sort',
  '$limit',
  '$skip',
  '$unwind',
  '$count',
  '$addFields',
  '$set',
  '$unset',
  '$replaceRoot',
  '$replaceWith',
  '$sortByCount',
  '$facet',
]);
const forbidden = new Set([
  '$where',
  '$function',
  '$accumulator',
  '$out',
  '$merge',
  '__proto__',
  'prototype',
  'constructor',
]);
export function validateMongoQuery(raw: unknown): MongoQuery {
  assertJsonInput(raw);
  const input = mongoInput.parse(raw);
  const fail = () => {
    throw new DatabaseError(
      'READ_ONLY_VIOLATION',
      '只允许 MongoDB 集合发现、find、count 和受限只读聚合；不允许写入、命令或 JavaScript。',
    );
  };
  if (
    input.operation !== 'listCollections' &&
    (!input.collection || input.collection.includes('\0') || input.collection.startsWith('system.'))
  )
    fail();
  const allowed: Record<MongoQuery['operation'], string[]> = {
    listCollections: ['operation'],
    find: ['operation', 'collection', 'filter', 'projection', 'sort', 'limit'],
    count: ['operation', 'collection', 'filter'],
    aggregate: ['operation', 'collection', 'pipeline', 'limit'],
  };
  if (Object.keys(input).some((key) => !allowed[input.operation].includes(key))) fail();
  if (input.operation === 'aggregate' && !input.pipeline) fail();
  const inspect = (value: unknown, depth: number): void => {
    if (depth > 30) fail();
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (forbidden.has(key)) fail();
      inspect(item, depth + 1);
    }
  };
  const pipeline = (items: unknown[], depth = 0): void => {
    if (depth > 5) fail();
    for (const stage of items) {
      if (!stage || typeof stage !== 'object' || Array.isArray(stage)) fail();
      const entries = Object.entries(stage!);
      if (entries.length !== 1 || !stages.has(entries[0]![0])) fail();
      if (entries[0]![0] === '$facet') {
        const facets = entries[0]![1];
        if (!facets || typeof facets !== 'object' || Array.isArray(facets)) fail();
        for (const nested of Object.values(facets)) {
          if (!Array.isArray(nested)) fail();
          pipeline(nested as unknown[], depth + 1);
        }
      }
    }
  };
  inspect(input, 0);
  if (input.pipeline) pipeline(input.pipeline);
  return input;
}
