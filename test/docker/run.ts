import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { docker, CommandFailure } from './process.js';
import { definitions, selectEngines } from './definitions.js';
import { withContainer, cleanupExpired } from './lifecycle.js';
import { waitReady, seed } from './fixtures.js';
import { exercise } from './scenarios.js';
import { exerciseColumnPermissions, exerciseOracleConstraints } from './permissions.js';
import { verifyCleanup } from './cleanup-check.js';
import { exerciseEcommerceExample } from './ecommerce.js';

const { values } = parseArgs({
  options: {
    engines: { type: 'string' },
    timeout: { type: 'string' },
    cleanup: { type: 'boolean' },
    help: { type: 'boolean' },
    'verify-cleanup': { type: 'boolean' },
  },
});
if (values.help) {
  console.log(
    'npm run test:docker -- [--engines mysql,postgresql,...] [--timeout 600] [--verify-cleanup]\nnpm run test:docker:cleanup  (expired test containers only)',
  );
} else {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    const selected = selectEngines(values.engines);
    const timeout = Number(values.timeout ?? 600);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 1800)
      throw new Error('--timeout must be 1–1800 seconds');
    const endpoint =
      process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT
        ? process.env.DOCKER_HOST
        : await docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
    if (!/^(unix|npipe):\/\//.test(endpoint))
      throw new Error('This test command requires a local Docker socket/context');
    // Freeze this process and its watchdogs to the inspected local daemon, even if the user
    // switches their default context while a test is running. No Docker config is modified.
    process.env.DOCKER_HOST = endpoint;
    delete process.env.DOCKER_CONTEXT;
    const info = JSON.parse(
      await docker(['info', '--format', '{{json .}}'], { signal: controller.signal }),
    );
    if (info.OSType !== 'linux') throw new Error('Linux containers are required');
    if (values.cleanup) console.log(`Removed ${await cleanupExpired()} expired test containers`);
    else {
      if (selected.includes('sqlserver') && !['x86_64', 'amd64'].includes(info.Architecture))
        throw new Error('SQL Server requires native amd64; select other engines on ARM');
      if (
        selected.some((engine) => engine === 'sqlserver' || engine === 'oracle') &&
        info.MemTotal < 3.5 * 1024 ** 3
      )
        throw new Error('SQL Server/Oracle testing requires at least 3.5 GiB assigned to Docker');
      console.log(
        `Docker ${info.ServerVersion}; kernel ${info.KernelVersion}; sequential engines: ${selected.join(', ')}; per-engine deadline ${timeout}s`,
      );
      let failed = 0;
      for (const engine of selected) {
        if (controller.signal.aborted) break;
        let phase = 'image';
        try {
          const image = definitions[engine].image;
          console.log(`[${engine}] Checking image ${image}`);
          let cached = true;
          await docker(['image', 'inspect', image], { signal: controller.signal }).catch(() => {
            cached = false;
          });
          if (!cached) {
            for (let attempt = 1; ; attempt++) {
              try {
                console.log(`[${engine}] Pull attempt ${attempt}/3 (up to 15 min)`);
                await docker(['pull', image], { signal: controller.signal, timeoutMs: 900000 });
                break;
              } catch (error) {
                if (attempt === 3 || controller.signal.aborted) throw error;
                await delay(2000, undefined, { signal: controller.signal });
              }
            }
          }
          const metadata = JSON.parse(
            await docker(['image', 'inspect', '--format', '{{json .}}', image], {
              signal: controller.signal,
            }),
          );
          console.log(`[${engine}] ${metadata.Id}; ${metadata.RepoDigests?.join(', ')}`);
          phase = 'create/start';
          await withContainer(
            engine,
            async (instance) => {
              console.log(
                `[${engine}] ${instance.name}; 127.0.0.1:${instance.port}; memory ${definitions[engine].memory}`,
              );
              phase = 'readiness';
              await waitReady(instance);
              phase = 'seed';
              await seed(instance);
              phase = 'dynamic tests';
              await exercise(instance);
              await exerciseColumnPermissions(instance);
              await exerciseOracleConstraints(instance);
              await exerciseEcommerceExample(instance);
              phase = 'cleanup';
            },
            { signal: controller.signal, timeoutMs: timeout * 1000 },
          );
          console.log(`[${engine}] PASS; container and anonymous volumes removed`);
        } catch (error: any) {
          failed++;
          // Raw driver messages/SQL/container logs are intentionally not emitted.
          console.error(
            `[${engine}] FAIL during ${phase}: ${error.code ?? error.name ?? 'Error'}${error.name === 'AssertionError' ? ` (${error.operator})` : ''}`,
          );
          if (error instanceof CommandFailure) console.error(error.message);
          const location = String(error.stack)
            .split('\n')
            .find((line) => /test[\\/]docker[\\/](scenarios|permissions)\.ts:\d+:\d+/.test(line));
          if (location) console.error(location.trim());
        }
      }
      if (values['verify-cleanup'] && !controller.signal.aborted && !failed)
        await verifyCleanup(
          selected.includes('postgresql') ? 'postgresql' : selected[0]!,
          controller.signal,
        );
      if (controller.signal.aborted) {
        console.error('Interrupted; cleanup attempted (check any failures above)');
        process.exitCode = 130;
      } else if (failed) {
        console.error(`${failed} engine(s) failed; requested engines are never silently skipped`);
        process.exitCode = 1;
      } else
        console.log(
          `PASS: ${selected.length} real database engines; this run's containers and volumes removed`,
        );
    }
  } catch (error: any) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
