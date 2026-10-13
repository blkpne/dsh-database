import type { ConnectionFields } from '../schema.js';
import type { ResultCollector } from '../result.js';
import type { MongoQuery } from '../mongo.js';
import type { SqlStatement, MetadataRequest } from '../inspect.js';

export interface Execution {
  config: ConnectionFields;
  password: string;
  signal: AbortSignal;
  result: ResultCollector;
}
export type AdapterInput = string | MongoQuery | SqlStatement | MetadataRequest;
export type Adapter = (input: AdapterInput, execution: Execution) => Promise<void>;
export const sqlStatement = (input: AdapterInput): { text: string; values: string[] } =>
  typeof input === 'string' ? { text: input, values: [] } : (input as SqlStatement);

/** Always detach listeners; a late successful connect remains owned by its adapter. */
export async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  cancel: () => void,
): Promise<T> {
  let listener!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    listener = () => {
      try {
        cancel();
      } catch {
        // Cancellation is best effort; the adapter still owns awaited cleanup in its finally.
      }
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', listener, { once: true });
    if (signal.aborted) listener();
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', listener);
  }
}

// TLS drivers use this name for certificate validation; preserve the configured identity.
export const networkHost = (host: string, tls = false) =>
  host === 'localhost' && !tls ? '127.0.0.1' : host.replace(/^\[|\]$/g, '');
