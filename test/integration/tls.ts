/** Existing-server tests use TLS unless plaintext is explicitly selected. */
export function integrationTls(env: NodeJS.ProcessEnv, key: string): boolean {
  const value = env[key];
  if (value === undefined || value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${key} must be true or false (unset defaults to true)`);
}
