import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function requiresFullChecks(files) {
  // Only known documentation paths may skip runtime checks. New/unknown paths fail closed.
  return (
    !files.length ||
    files.some(
      (file) =>
        !(
          /^(README|CONTRIBUTING|AGENTS|CHANGELOG)\.md$/.test(file) ||
          /^docs\/.*\.md$/.test(file) ||
          /^docs\/assets\/.*\.(png|jpe?g|svg|webp)$/.test(file)
        ),
    )
  );
}

export function fullChecksForEvent(
  event,
  env,
  git = (args) => execFileSync('git', args, { encoding: 'utf8' }),
) {
  if (env.CI_FULL_CHECK === 'true' || env.GITHUB_REF?.startsWith('refs/tags/')) return true;
  const pr = env.GITHUB_EVENT_NAME === 'pull_request';
  if (!pr && env.GITHUB_EVENT_NAME !== 'push') return true;
  const base = pr ? event.pull_request?.base?.sha : event.before;
  const head = pr ? event.pull_request?.head?.sha : event.after;
  const valid = (sha) =>
    typeof sha === 'string' && /^[a-f0-9]{40,64}$/i.test(sha) && !/^0+$/.test(sha);
  if (!valid(base) || !valid(head)) return true;
  try {
    // PRs compare against the merge base; pushes include the entire pushed range.
    // No rename detection: moving code into docs must still report the source deletion.
    const files = git([
      'diff',
      '--name-only',
      '--no-renames',
      '-z',
      pr ? `${base}...${head}` : base,
      ...(pr ? [] : [head]),
      '--',
    ])
      .split('\0')
      .filter(Boolean);
    return requiresFullChecks(files);
  } catch {
    console.warn('Change range unavailable; running the complete validation matrix.');
    return true;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let full = true;
  try {
    full = fullChecksForEvent(
      JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')),
      process.env,
    );
  } catch {
    console.warn('Event metadata unavailable; running the complete validation matrix.');
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `full=${full}\n`);
  console.log(full ? 'Full validation required.' : 'Documentation-only validation.');
}
