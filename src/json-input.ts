import { DatabaseError } from './errors.js';

/** Bound untrusted JSON before recursive schema parsing, stringify or BSON decoding. */
export function assertJsonInput(value: unknown, maximum = 32768, maxDepth = 30): void {
  let bytes = 0;
  const parents = new Set<object>();
  const fail = (): never => {
    throw new DatabaseError(
      'INVALID_INPUT',
      '查询 JSON 必须为有限、无循环的数据，且不超过 32 KiB 或 30 层。',
    );
  };
  const add = (size: number) => {
    bytes += size;
    if (bytes > maximum) fail();
  };
  const scalar = (item: string | number | boolean | null) => {
    if (typeof item === 'string' && item.length > maximum - bytes) fail();
    add(Buffer.byteLength(JSON.stringify(item)));
  };
  const inspect = (item: unknown, depth: number) => {
    if (depth > maxDepth) fail();
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return scalar(item);
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) fail();
      return scalar(item);
    }
    if (typeof item !== 'object' || !item || parents.has(item)) return fail();
    const array = Array.isArray(item);
    if (
      !array &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      fail();
    parents.add(item);
    add(2);
    let count = 0;
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      if (count++) add(1);
      if (!array) {
        scalar(key);
        add(1);
      }
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!('value' in descriptor)) fail();
      inspect(descriptor.value, depth + 1);
    }
    if (array && count !== item.length) fail();
    parents.delete(item);
  };
  inspect(value, 0);
}
