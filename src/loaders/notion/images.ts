import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

function stripJpeg(buffer: Buffer): Buffer {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return buffer;
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
  return modified ? Buffer.from(Buffer.concat(chunks)) : buffer;
}

function stripPng(buffer: Buffer): Buffer {
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
  return modified ? Buffer.from(Buffer.concat(chunks)) : buffer;
}

function stripWebp(buffer: Buffer): Buffer {
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
  const newPayload = Buffer.concat(chunks);
  const newHeader = Buffer.alloc(12);
  newHeader.write('RIFF', 0, 4, 'ascii');
  newHeader.writeUInt32LE(newPayload.length + 4, 4);
  newHeader.write('WEBP', 8, 4, 'ascii');
  return Buffer.from(Buffer.concat([newHeader, newPayload]));
}

export function stripExifMetadata(buffer: Buffer, ext: string): Buffer {
  try {
    if (ext === 'jpg' || ext === 'jpeg') return stripJpeg(buffer);
    if (ext === 'png') return stripPng(buffer);
    if (ext === 'webp') return stripWebp(buffer);
  } catch {
    // If parsing fails, preserve original
  }
  return buffer;
}

/**
 * Downloads a remote image from Notion to public/assets/notion/ and src/assets/notion/ so it never expires.
 * Automatically strips all EXIF and GPS metadata before saving.
 */
export async function downloadRemoteImage(
  url: string,
  options?: { maxWidth?: number; quality?: number; format?: 'webp' | 'original' }
): Promise<string> {
  if (!url || !url.startsWith('http')) return url;

  try {
    const publicNotionDir = path.resolve('public/assets/notion');
    const srcNotionDir = path.resolve('src/assets/notion');
    if (!fs.existsSync(publicNotionDir)) {
      fs.mkdirSync(publicNotionDir, { recursive: true });
    }
    if (!fs.existsSync(srcNotionDir)) {
      fs.mkdirSync(srcNotionDir, { recursive: true });
    }

    // Determine extension
    const cleanUrl = url.split('?')[0];
    const extMatch = cleanUrl.match(/\.(webp|png|jpe?g|svg|gif)$/i);
    const rawExt = extMatch ? extMatch[1].toLowerCase() : 'webp';

    const isVectorOrAnim = rawExt === 'svg' || rawExt === 'gif';
    const shouldConvertToWebp = !isVectorOrAnim && options?.format !== 'original';
    const ext = shouldConvertToWebp ? 'webp' : rawExt;

    const hash = crypto.createHash('md5').update(cleanUrl).digest('hex').slice(0, 12);
    const filename = `${hash}.${ext}`;
    const publicTargetPath = path.join(publicNotionDir, filename);
    const srcTargetPath = path.join(srcNotionDir, filename);

    if (!fs.existsSync(srcTargetPath) || !fs.existsSync(publicTargetPath)) {
      let rawBuffer: Buffer | null = null;

      // Check if existing raw version already exists locally on disk
      const existingRawPublic = path.join(publicNotionDir, `${hash}.${rawExt}`);
      const existingRawSrc = path.join(srcNotionDir, `${hash}.${rawExt}`);
      if (fs.existsSync(existingRawPublic)) {
        rawBuffer = fs.readFileSync(existingRawPublic);
      } else if (fs.existsSync(existingRawSrc)) {
        rawBuffer = fs.readFileSync(existingRawSrc);
      } else {
        const response = await fetch(url);
        if (response.ok) {
          rawBuffer = Buffer.from(await response.arrayBuffer());
        }
      }

      if (rawBuffer) {
        let cleanBuffer: Buffer = rawBuffer;

        if (!isVectorOrAnim) {
          try {
            let pipeline = sharp(rawBuffer).rotate();
            const maxWidth = options?.maxWidth || 1000;
            pipeline = pipeline.resize({ width: maxWidth, withoutEnlargement: true });
            if (shouldConvertToWebp) {
              pipeline = pipeline.webp({ quality: options?.quality || 82 });
            }
            cleanBuffer = await pipeline.toBuffer();
          } catch {
            cleanBuffer = stripExifMetadata(rawBuffer, rawExt);
          }
        }

        if (!fs.existsSync(publicTargetPath)) {
          fs.writeFileSync(publicTargetPath, cleanBuffer);
        }
        if (!fs.existsSync(srcTargetPath)) {
          fs.writeFileSync(srcTargetPath, cleanBuffer);
        }
      } else {
        return url;
      }
    }

    return `/assets/notion/${filename}`;
  } catch (err) {
    console.error('Error downloading Notion image:', err);
    return url;
  }
}

/**
 * Extract an image source from Notion property (uploaded file, external URL, or text path).
 */
export async function extractImageSource(
  filesProp: any,
  textProp: any,
  options?: { maxWidth?: number; quality?: number; format?: 'webp' | 'original' }
): Promise<string> {
  const fileObj = filesProp?.files?.[0];
  if (fileObj) {
    const rawUrl = fileObj.file?.url || fileObj.external?.url;
    if (rawUrl) {
      return await downloadRemoteImage(rawUrl, options);
    }
  }

  const textVal = textProp?.rich_text?.[0]?.plain_text;
  if (textVal) {
    if (textVal.startsWith('http')) {
      return await downloadRemoteImage(textVal, options);
    }
    return textVal;
  }

  return '';
}
