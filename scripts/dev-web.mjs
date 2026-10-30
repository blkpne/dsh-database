import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { artifactsPath } from './paths.mjs';
import { processBackend, runCommand } from './dev-platform.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function options(args, env = process.env) {
  const mode = args[0] ?? 'start';
  if (!['start', 'mount'].includes(mode) || args.slice(1).some((arg) => arg !== '--no-open'))
    throw new Error('用法: node scripts/dev-web.mjs [start|mount] [--no-open]');
  const port = env.DSH_DATABASE_WEB_PORT ?? '3080';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error('DSH_DATABASE_WEB_PORT 必须为 1–65535 的整数。');
  const profile = env.DSH_DATABASE_WEB_PROFILE ?? 'web';
  if (!/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error('Profile 名称只能包含字母、数字、_、-。');
  if (['headless', 'sdk', 'sdk-minimal', 'acp'].includes(profile))
    throw new Error('请选择 web 或基于 Web 的自定义 Profile。');
  return {
    mode,
    port: Number(port),
    profile,
    dshHome: resolve(env.DSH_HOME || join(homedir(), '.dsh')),
    workspace: resolve(env.DSH_DATABASE_WEB_WORKSPACE || project),
    noOpen: args.includes('--no-open'),
  };
}

// Only the original listeners are terminated. A replacement process is never swept up.
export async function releasePort(port, graceMs = 6000, backend = processBackend()) {
  const { listeners, identity, terminate } = backend;
  const targets = await Promise.all(
    (await listeners(port)).map(async (pid) => [pid, await identity(pid)]),
  );
  const sameProcess = async ([pid, started]) => started && (await identity(pid)) === started;
  const terminateOriginal = async (target, force) => {
    try {
      await terminate(target[0], force);
    } catch (error) {
      // taskkill can report failure if the process exits between the check and the command.
      if (await sameProcess(target)) throw error;
    }
  };
  for (const target of targets) {
    if (!target[1]) throw new Error(`无法确认 PID ${target[0]} 的身份，停止启动。`);
    if (target[0] === process.pid) throw new Error('目标端口由启动器自身占用，停止操作。');
    if (!(await sameProcess(target))) continue;
    console.log(`请求关闭端口 ${port} 的原监听进程 PID ${target[0]}。`);
    await terminateOriginal(target, false);
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && (await Promise.all(targets.map(sameProcess))).some(Boolean))
    await delay(100);
  for (const target of targets) {
    if (!(await sameProcess(target))) continue;
    console.log(`PID ${target[0]} 未在 ${graceMs} ms 内退出，强制结束。`);
    await terminateOriginal(target, true);
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    if (
      !(await listeners(port)).length &&
      !(await Promise.all(targets.map(sameProcess))).some(Boolean)
    )
      return;
    await delay(100);
  }
  throw new Error(`端口 ${port} 尚未释放或被新进程占用，停止启动；不自动换端口。`);
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log(
      'npm run dev:web [-- --no-open]：构建、挂载并启动；npm run dev:mount：构建、停用端口占用进程并挂载。\n默认复用 ~/.dsh / web，端口 3080。可设置 DSH_HOME、DSH_DATABASE_WEB_PROFILE、DSH_DATABASE_WEB_PORT、DSH_DATABASE_WEB_WORKSPACE、DSH_DATABASE_TEST_ROOT。',
    );
    return;
  }
  const config = options(process.argv.slice(2));
  const backend = processBackend();
  if (!(await stat(config.workspace)).isDirectory()) throw new Error('启动工作目录不是文件夹。');
  const env = { ...process.env, DSH_HOME: config.dshHome };
  const npm = process.env.npm_execpath ? process.execPath : 'npm';
  const npmArgs = process.env.npm_execpath ? [process.env.npm_execpath] : [];
  const lifetime = new AbortController();
  const interrupt = () => lifetime.abort();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const execOptions = { env, signal: lifetime.signal };
  const run = (command, args, cwd = project, quiet = false) =>
    runCommand(command, args, { cwd, ...execOptions, quiet, capture: false });
  try {
    // Prepare a content-addressed tarball before interrupting the current Web service.
    await runCommand('dsh', ['--version'], execOptions);
    await runCommand('pnpm', ['--version'], execOptions);
    const manifestPath = join(config.dshHome, 'profiles', config.profile, 'package.json');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (!manifest.dsh?.profile?.bundles?.includes('@deepseek-ai/dsh-web-app'))
        throw new Error('目标 Profile 没有官方 Web Bundle，停止挂载；请选择 Web Profile。');
    }
    await backend.listeners(config.port);
    await run(npm, [...npmArgs, 'run', 'build']);
    const artifacts = artifactsPath('dev-web', 'artifacts');
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(artifacts, '.pack-'));
    let archive;
    try {
      const { stdout } = await runCommand(
        npm,
        [...npmArgs, 'pack', '--ignore-scripts', '--json', '--pack-destination', staging],
        { cwd: project, ...execOptions },
      );
      const [pack] = JSON.parse(stdout);
      const packed = join(staging, pack.filename);
      const hash = createHash('sha256')
        .update(await readFile(packed))
        .digest('hex');
      archive = join(artifacts, `${hash}.tgz`);
      await rename(packed, archive);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    console.log(
      `复用 ${config.dshHome} / ${config.profile}；工作目录 ${config.workspace}；端口 ${config.port}。`,
    );
    lifetime.signal.throwIfAborted();
    await releasePort(config.port, 6000, backend);
    const profileArgs = ['--profile', config.profile];
    const initialize =
      !existsSync(join(config.dshHome, 'profiles', config.profile)) && config.profile !== 'web';
    await run(
      'dsh',
      [...profileArgs, ...(initialize ? ['--from-default-profile', 'web'] : []), '--help'],
      config.workspace,
      true,
    );
    // Built artifact: Oracle Thin needs no install hook. This flag affects this install only.
    await run(
      'dsh',
      ['plugin', ...profileArgs, 'add', archive, '--ignore-scripts'],
      config.workspace,
    );
    if (config.mode === 'mount') {
      console.log('挂载完成。运行 npm run dev:web 启动；原有配置、凭据和工作空间记录已保留。');
      return;
    }
    await run(
      'dsh',
      [
        ...profileArgs,
        '--host',
        '127.0.0.1',
        '--port',
        String(config.port),
        ...(config.noOpen ? ['--no-open'] : []),
      ],
      config.workspace,
    );
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
