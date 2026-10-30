import { setTimeout as delay } from 'node:timers/promises';
import { withContainer } from './lifecycle.js';
import { selectEngines } from './definitions.js';

// Used only by --verify-cleanup; communicates names, never connection credentials.
const controller = new AbortController();
process.on('SIGTERM', () => controller.abort());
process.on('SIGINT', () => controller.abort());
try {
  await withContainer(
    selectEngines(process.argv[2])[0]!,
    async ({ name, signal }) => {
      process.send?.({ name });
      await delay(60000, undefined, { signal });
    },
    { signal: controller.signal },
  );
} catch {
  process.exitCode = controller.signal.aborted ? 130 : 1;
} finally {
  if (process.connected) process.disconnect();
}
