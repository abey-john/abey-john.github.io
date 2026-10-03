import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const assetsDir = join(rootDir, 'src', 'assets');

if (!existsSync(assetsDir)) {
  console.log('No local src/assets directory found.');
  process.exit(0);
}

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

function stripJpeg(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return buffer;
  }

  const chunks = [buffer.subarray(0, 2)];
  let offset = 2;
  let modified = false;

  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      chunks.push(buffer.subarray(offset));
      break;
    }

    const marker = buffer[offset + 1];
    if (marker === 0xd9 || marker === 0xda) {
      chunks.push(buffer.subarray(offset));
      break;
    }

    const length = buffer.readUInt16BE(offset + 2);
    if (marker === 0xe1) {
      modified = true;
    } else {
      chunks.push(buffer.subarray(offset, offset + 2 + length));
    }

    offset += 2 + length;
  }

  return modified ? Buffer.concat(chunks) : buffer;
}

function stripPng(buffer) {
  if (buffer.length < 8) return buffer;
  const header = buffer.subarray(0, 8);
  const chunks = [header];
  let offset = 8;
  let modified = false;

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const totalChunkLength = 12 + length;

    if (type === 'eXIf' || type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      modified = true;
    } else {
      chunks.push(buffer.subarray(offset, offset + totalChunkLength));
    }

    offset += totalChunkLength;
  }

  return modified ? Buffer.concat(chunks) : buffer;
}

function stripWebp(buffer) {
  if (buffer.length < 12) return buffer;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
    return buffer;
  }

  const chunks = [];
  let offset = 12;
  let modified = false;

  while (offset + 8 <= buffer.length) {
    const chunkType = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const totalChunkLength = 8 + chunkSize + (chunkSize % 2);

    if (chunkType === 'EXIF' || chunkType === 'XMP ') {
      modified = true;
    } else {
      chunks.push(buffer.subarray(offset, offset + totalChunkLength));
    }

    offset += totalChunkLength;
  }

  if (!modified) return buffer;

  const body = Buffer.concat(chunks);
  const riffHeader = Buffer.alloc(12);
  riffHeader.write('RIFF', 0, 4, 'ascii');
  riffHeader.writeUInt32LE(body.length + 4, 4);
  riffHeader.write('WEBP', 8, 4, 'ascii');

  return Buffer.concat([riffHeader, body]);
}

const targetFiles = process.argv.slice(2).length > 0 
  ? process.argv.slice(2) 
  : getFiles(assetsDir);

let strippedCount = 0;

for (const file of targetFiles) {
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
  const buffer = readFileSync(file);
  let stripped = buffer;

  if (ext === '.jpg' || ext === '.jpeg') {
    stripped = stripJpeg(buffer);
  } else if (ext === '.png') {
    stripped = stripPng(buffer);
  } else if (ext === '.webp') {
    stripped = stripWebp(buffer);
  }

  if (stripped !== buffer) {
    writeFileSync(file, stripped);
    strippedCount++;
    console.log(`Stripped EXIF: ${relative(rootDir, file).replace(/\\/g, '/')}`);
  }
}

console.log(`Done. Stripped metadata from ${strippedCount} file(s).`);
