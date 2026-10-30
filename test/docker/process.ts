import { spawn } from 'node:child_process';

export interface CommandOptions {
  input?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class CommandFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// Classify known setup failures, never interpolate raw output or arbitrary argv.
export function commandFailure(
  program: string,
  status: number | null,
  stderr: string,
): CommandFailure {
  if (program === 'docker') {
    const hints: [RegExp, string, string][] = [
      [
        /cannot connect to the docker daemon|is the docker daemon running|connection refused/i,
        'DOCKER_UNAVAILABLE',
        'Start Docker and check the selected local context with docker info.',
      ],
      [
        /no such image|unable to find image|pull access denied|manifest unknown/i,
        'DOCKER_IMAGE_UNAVAILABLE',
        'Check registry access and pull the image listed in test/docker/definitions.ts.',
      ],
      [
        /no matching manifest|exec format error|does not match.*platform/i,
        'DOCKER_PLATFORM',
        'The image does not support this Docker architecture; select compatible engines.',
      ],
      [
        /no space left on device|insufficient memory|not enough memory|requested cpus/i,
        'DOCKER_RESOURCES',
        'Check Docker disk, memory and CPU availability.',
      ],
      [
        /permission denied|access is denied/i,
        'DOCKER_PERMISSION',
        'Check permission to access the selected local Docker daemon.',
      ],
    ];
    for (const [pattern, code, hint] of hints)
      if (pattern.test(stderr))
        return new CommandFailure(code, `docker exited with code ${status}. ${hint}`);
    return new CommandFailure(
      'DOCKER_COMMAND_FAILED',
      `docker exited with code ${status}. Check docker info, image availability and resource limits; raw output is suppressed to protect fixture credentials.`,
    );
  }
  return new CommandFailure('COMMAND_FAILED', `${program} exited with code ${status}`);
}

// Never include argv, stdin, child output or environment in errors (they may contain secrets).
export function command(
  program: string,
  args: string[],
  options: CommandOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted();
    const child = spawn(program, args, {
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let stderr = '';
    let failure: Error | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill('SIGKILL');
    };
    const abort = () => stop(new Error('Command canceled'));
    const timer = setTimeout(
      () => stop(new Error('Command timed out')),
      options.timeoutMs ?? 30000,
    );
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.setEncoding('utf8').on('data', (text: string) => {
      output += text;
      if (output.length > 2 * 1024 * 1024) stop(new Error('Command output exceeded limit'));
    });
    child.stderr.setEncoding('utf8').on('data', (text: string) => {
      if (stderr.length < 32768) stderr += text.slice(0, 32768 - stderr.length);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(options.input);
    child.on('error', () => {
      failure ??= new Error(`Cannot start ${program}`);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(commandFailure(program, code, stderr));
      else resolve(output.trim());
    });
  });
}

export type DockerCommand = (args: string[], options?: CommandOptions) => Promise<string>;
export const docker: DockerCommand = (args, options) => command('docker', args, options);
