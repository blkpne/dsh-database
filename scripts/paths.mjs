import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const projectPath = (...parts) => join(project, ...parts);
export const artifactsPath = (...parts) =>
  resolve(project, process.env.DSH_DATABASE_TEST_ROOT || 'test-results', ...parts);

export async function linkDependencies(directory) {
  await symlink(
    projectPath('node_modules'),
    join(directory, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
}

// Each invocation owns its directory; parallel checkouts never reuse a stale module link.
export async function temporaryDirectory(prefix, modules = false) {
  const root = artifactsPath();
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, prefix));
  try {
    if (modules) await linkDependencies(directory);
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
