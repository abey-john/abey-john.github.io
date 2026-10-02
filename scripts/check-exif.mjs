import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const assetsDir = join(rootDir, 'src', 'assets');

function getFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getFiles(fullPath));
    } else {
      files.push(fullPath);
    }
  }

  return files;
}

function hasJpegExif(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return false;
  }

  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) break;

    const marker = buffer[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break;

    const length = buffer.readUInt16BE(offset + 2);
    if (marker === 0xe1) {
      const header = buffer.toString('ascii', offset + 4, offset + 8);
      if (header === 'Exif') {
        return true;
      }
    }

    offset += 2 + length;
  }

  return false;
}

function hasPngExif(buffer) {
  if (buffer.length < 8) return false;
  let offset = 8;

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);

    if (type === 'eXIf') {
      return true;
    }

    offset += 12 + length;
  }

  return false;
}

function hasWebpExif(buffer) {
  if (buffer.length < 12) return false;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
    return false;
  }

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkType = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);

    if (chunkType === 'EXIF') {
      return true;
    }

    offset += 8 + chunkSize + (chunkSize % 2);
  }

  return false;
}

const files = getFiles(assetsDir);
const violations = [];

for (const file of files) {
  const rel = relative(rootDir, file).replace(/\\/g, '/');
  const buffer = readFileSync(file);
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase();

  let hasExif = false;
  if (ext === '.jpg' || ext === '.jpeg') {
    hasExif = hasJpegExif(buffer);
  } else if (ext === '.png') {
    hasExif = hasPngExif(buffer);
  } else if (ext === '.webp') {
    hasWebpExif(buffer);
  }

  if (hasExif) {
    violations.push(rel);
  }
}

if (violations.length > 0) {
  console.error(`Error: Found ${violations.length} image(s) containing EXIF metadata:`);
  for (const v of violations) {
    console.error(`  - ${v}`);
  }
  process.exit(1);
}

console.log(`EXIF check passed: all ${files.length} assets are free of EXIF metadata.`);
process.exit(0);
