import { chmod } from 'node:fs/promises';
import { join } from 'node:path';

/** Owned, disposable test directory only; the CA private key never enters a container. */
export async function prepareTlsFiles(directory: string) {
  await chmod(directory, 0o700);
  for (const name of ['ca.key', 'server.key']) await chmod(join(directory, name), 0o600);
  for (const name of ['ca', 'matching', 'dns', 'ip', 'wrong', 'expired'])
    await chmod(join(directory, `${name}.pem`), 0o644);
}
