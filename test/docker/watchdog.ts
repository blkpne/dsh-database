import { setTimeout as delay } from 'node:timers/promises';
import { removeContainer } from './lifecycle.js';

// Separate process, no credentials or daemon socket mount. IPC closes even on parent SIGKILL.
const [name, timeout] = process.argv.slice(2);
let cleaning = false;
async function cleanup() {
  if (cleaning) return;
  cleaning = true;
  clearTimeout(timer);
  // Repeat to cover a Docker create request that completes after its CLI/parent was killed.
  let failed = false;
  for (let attempt = 0; attempt < 7; attempt++) {
    try {
      await removeContainer(name!);
      failed = false;
    } catch {
      failed = true;
    }
    if (attempt < 6) await delay(10000);
  }
  if (failed)
    console.error(
      'Docker cleanup watchdog could not reach the daemon; run npm run test:docker:cleanup.',
    );
  process.exit(failed ? 1 : 0);
}
const timer = setTimeout(() => void cleanup(), Number(timeout));
process.on('disconnect', () => void cleanup());
process.on('message', (message) => {
  if (message === 'clean') process.exit(0);
});
process.send?.('ready');
