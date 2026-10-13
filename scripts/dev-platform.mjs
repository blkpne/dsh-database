import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import spawn from 'cross-spawn';

const exec = promisify(execFile);

/** Platform operations are separate so PID reuse and Windows command errors are testable. */
export function processBackend(platform = process.platform, execute = exec) {
  const windows = platform === 'win32';
  if (!windows && !['darwin', 'linux'].includes(platform))
    throw new Error('Web 开发脚本支持 Windows、macOS 和 Linux。');
  const powershell = async (script) => {
    const encoded = Buffer.from(
      `$ErrorActionPreference = 'Stop'; ${script}; exit 0`,
      'utf16le',
    ).toString('base64');
    return execute(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 15000 },
    );
  };
  const positiveInteger = (value) => {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('无效的进程或端口编号。');
    return value;
  };
  return {
    async listeners(port) {
      positiveInteger(port);
      try {
        const { stdout } = windows
          ? await powershell(
              `$owners = @(Get-NetTCPConnection -ErrorAction Stop | Where-Object { $_.State -eq 'Listen' -and $_.LocalPort -eq ${port} } | Select-Object -ExpandProperty OwningProcess -Unique); ConvertTo-Json -InputObject $owners -Compress`,
            )
          : await execute('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
        const values = windows
          ? JSON.parse(stdout.trim())
          : stdout.trim().split(/\s+/).filter(Boolean).map(Number);
        if (!Array.isArray(values)) throw new Error('Unexpected listener response');
        return [...new Set(values.map(positiveInteger))];
      } catch (error) {
        if (!windows && error.code === 1 && !error.stdout?.trim() && !error.stderr?.trim())
          return [];
        throw new Error(
          windows
            ? '无法查询监听进程；需要 Windows PowerShell 与 Get-NetTCPConnection，请检查系统组件及访问权限。'
            : '无法查询监听进程；需要 macOS/Linux 的 lsof。',
          { cause: error },
        );
      }
    },
    async identity(pid) {
      positiveInteger(pid);
      try {
        const { stdout } = windows
          ? await powershell(
              `$targetProcess = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($null -ne $targetProcess) { $targetProcess.StartTime.ToUniversalTime().Ticks.ToString() }`,
            )
          : await execute('ps', ['-p', String(pid), '-o', 'lstart=']);
        return stdout.trim();
      } catch (error) {
        if (!windows && error.code === 1) return '';
        throw new Error(`无法核对 PID ${pid} 的启动时间，停止操作。`, { cause: error });
      }
    },
    async terminate(pid, force) {
      positiveInteger(pid);
      if (windows) {
        try {
          // No /T: an existing listener is not a process tree owned by this launcher.
          await execute('taskkill.exe', ['/PID', String(pid), ...(force ? ['/F'] : [])], {
            windowsHide: true,
            timeout: 10000,
          });
        } catch (error) {
          // Console applications may reject a non-forced close. Wait before escalation.
          if (!force && typeof error.code === 'number') return;
          throw new Error(
            `无法${force ? '强制' : ''}结束 PID ${pid}；请在原终端停止服务或检查进程权限。`,
            { cause: error },
          );
        }
      } else {
        try {
          process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
    },
  };
}

async function stopPosixGroup(pid) {
  const signalGroup = (signal) => {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  signalGroup('SIGTERM');
  const deadline = Date.now() + 6000;
  let forced = false;
  let inspectionError;
  for (;;) {
    // Zombies cannot execute or write files and may await an external reaper on Linux.
    let alive = true;
    try {
      const { stdout } = await exec('ps', ['-A', '-o', 'pgid=,stat='], { timeout: 2000 });
      alive = stdout.split('\n').some((line) => {
        const [group, state] = line.trim().split(/\s+/);
        return Number(group) === pid && state && !state.startsWith('Z');
      });
    } catch (error) {
      inspectionError = error;
      // Inspection failure must not prevent escalation of our own process group.
      try {
        process.kill(-pid, 0);
      } catch (error) {
        if (error.code === 'ESRCH') alive = false;
        else throw error;
      }
    }
    if (!alive) return;
    if (!forced && Date.now() >= deadline) {
      signalGroup('SIGKILL');
      forced = true;
    }
    if (Date.now() >= deadline + 3000)
      throw new Error('无法确认本次启动的进程组已停止，请检查其进程。', { cause: inspectionError });
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Cross-spawn handles npm .cmd shims and quoting without interpolating an ad-hoc shell command. */
export function runCommand(
  command,
  args,
  { signal, capture = true, quiet = false, ...options } = {},
) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      // Own a separate POSIX group so npm/shell/compiler descendants can be canceled together.
      detached: process.platform !== 'win32',
      stdio: quiet ? 'ignore' : capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '',
      stderr = '',
      failure,
      timer,
      stopping;
    const stop = () => {
      failure ??= signal?.reason ?? new Error('Command canceled');
      if (process.platform !== 'win32') {
        if (child.pid && !stopping)
          stopping = stopPosixGroup(child.pid).catch((error) => {
            failure = error;
            cleanup();
            reject(error);
          });
        return;
      }
      if (!child.pid || child.exitCode !== null || child.signalCode !== null || timer) return;
      const terminate = (force) => {
        if (process.platform === 'win32') {
          // /T is limited to this invocation's child and its descendants, never port owners.
          void exec('taskkill.exe', ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])], {
            windowsHide: true,
            timeout: 10000,
          }).catch((error) => {
            if (force && child.exitCode === null && child.signalCode === null) {
              cleanup();
              reject(new Error('无法停止本次启动的命令，请在原终端检查其进程。', { cause: error }));
            }
          });
        }
      };
      terminate(false);
      timer = setTimeout(() => terminate(true), 6000);
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
    };
    const collect = (stream) => (chunk) => {
      if (failure) return;
      if (stream === 'stdout') stdout += chunk;
      else stderr += chunk;
      if (stdout.length + stderr.length > 4 * 1024 * 1024) {
        failure = new Error(`${command} 输出超过限制。`);
        stop();
      }
    };
    child.stdout?.setEncoding('utf8').on('data', collect('stdout'));
    child.stderr?.setEncoding('utf8').on('data', collect('stderr'));
    child.once('error', (error) => {
      failure ??= error;
    });
    child.once('close', async (code, exitSignal) => {
      await stopping;
      cleanup();
      if (failure) reject(failure);
      else if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args[0] ?? ''} 未完成（${exitSignal ?? code}）。`));
    });
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
  });
}
