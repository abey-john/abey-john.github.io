import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const isStrict = process.argv.includes('--strict');
const rootDir = fileURLToPath(new URL('..', import.meta.url));
const scanDir = join(rootDir, 'src');

const textExtensions = new Set([
  '.astro',
  '.ts',
  '.js',
  '.mjs',
  '.md',
  '.json',
  '.yaml',
  '.yml',
]);

function getFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getFiles(fullPath));
    } else {
      const ext = fullPath.slice(fullPath.lastIndexOf('.'));
      if (textExtensions.has(ext)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

const files = getFiles(scanDir);
const matches = [];

for (const file of files) {
  const relPath = relative(rootDir, file).replace(/\\/g, '/');
  const content = readFileSync(file, 'utf-8');
  const lines = content.split('\n');

  lines.forEach((line, index) => {
    if (line.includes('PLACEHOLDER:')) {
      matches.push({
        file: relPath,
        line: index + 1,
        content: line.trim(),
      });
    }
  });
}

if (matches.length === 0) {
  console.log('No placeholders found.');
  process.exit(0);
}

console.log(`Found ${matches.length} placeholder(s):\n`);
for (const match of matches) {
  console.log(`  ${match.file}:${match.line} -> ${match.content}`);
}
console.log('');

if (isStrict) {
  console.error(`Error: ${matches.length} unresolved placeholder(s) remaining in strict mode.`);
  process.exit(1);
} else {
  process.exit(0);
}
