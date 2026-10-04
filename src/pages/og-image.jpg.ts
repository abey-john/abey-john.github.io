import type { APIRoute } from 'astro';
import { getEntry } from 'astro:content';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

export const GET: APIRoute = async () => {
  const aboutEntry = await getEntry('about', 'index');
  const photoPath = aboutEntry?.data?.photo;

  let sourceBuffer: Buffer | null = null;

  if (photoPath) {
    // Check public/ first, then src/assets/
    const publicCandidate = path.join(process.cwd(), 'public', photoPath.replace(/^\//, ''));
    const srcCandidate = path.join(process.cwd(), 'src', photoPath.replace(/^\//, ''));

    if (fs.existsSync(publicCandidate)) {
      sourceBuffer = fs.readFileSync(publicCandidate);
    } else if (fs.existsSync(srcCandidate)) {
      sourceBuffer = fs.readFileSync(srcCandidate);
    }
  }

  // If no about photo found, generate a clean dark fallback
  if (!sourceBuffer) {
    const fallback = await sharp({
      create: {
        width: 1200,
        height: 630,
        channels: 3,
        background: { r: 15, g: 20, b: 28 },
      },
    })
      .jpeg({ quality: 90 })
      .toBuffer();

    return new Response(fallback, {
      headers: {
        'Content-Type': 'image/jpeg',
      },
    });
  }

  // Calculate dynamic 1200x630 crop biased slightly towards torso (60% vertical anchor)
  const meta = await sharp(sourceBuffer).metadata();
  const srcWidth = meta.width || 1200;
  const srcHeight = meta.height || 630;

  // Scale so width is 1200 (or height is at least 630)
  const scale = Math.max(1200 / srcWidth, 630 / srcHeight);
  const scaledWidth = Math.round(srcWidth * scale);
  const scaledHeight = Math.round(srcHeight * scale);

  const maxTop = Math.max(0, scaledHeight - 630);
  const top = Math.round(maxTop * 0.64); // "More Torso" anchor

  const maxLeft = Math.max(0, scaledWidth - 1200);
  const left = Math.round(maxLeft * 0.5);

  const outputBuffer = await sharp(sourceBuffer)
    .resize(scaledWidth, scaledHeight)
    .extract({ left, top, width: 1200, height: 630 })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();

  return new Response(outputBuffer, {
    headers: {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
};
