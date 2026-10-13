import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(path) : entry.name.endsWith('.md') ? [path] : [];
  });
}

// Check repository-local inline links and heading anchors; remote availability is a separate check.
const files = [
  ...readdirSync('.').filter((file) => file.endsWith('.md')),
  ...markdownFiles('docs'),
  ...(existsSync('.github') ? markdownFiles('.github') : []),
];
function headings(text) {
  const seen = new Map();
  return new Set(
    [...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => {
      const slug = match[1]
        .replace(/[`*]/g, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}_\- ]/gu, '')
        .trim()
        .replace(/ /g, '-');
      const count = seen.get(slug) ?? 0;
      seen.set(slug, count + 1);
      return count ? `${slug}-${count}` : slug;
    }),
  );
}
for (const file of files) {
  const text = readFileSync(file, 'utf8').replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, '');
  for (const [, link] of text.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(link)) continue;
    const [path, anchor] = link.split('#');
    const target = path ? resolve(dirname(file), decodeURIComponent(path)) : resolve(file);
    assert(existsSync(target), `${file}: missing link target ${link}`);
    if (anchor && extname(target) === '.md')
      assert(
        headings(readFileSync(target, 'utf8')).has(decodeURIComponent(anchor)),
        `${file}: missing heading ${link}`,
      );
  }
}
console.log(`Local documentation links verified: ${files.length} Markdown files.`);
