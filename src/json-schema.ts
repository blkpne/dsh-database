import { z } from 'zod';

// The all-keys pattern retains record validation while using patternProperties,
// which also works with JSON Schema converters from older host-pinned Zod minors.
export function jsonRecord<T extends z.ZodType>(value: T) {
  return z.looseRecord(z.string().regex(/^[\s\S]*$/), value);
}

type JsonValue = z.infer<ReturnType<typeof z.json>>;
export const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    jsonRecord(jsonValue),
  ]),
);
