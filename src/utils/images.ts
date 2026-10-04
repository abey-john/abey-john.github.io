import type { ImageMetadata } from 'astro';

const allNotionImages = import.meta.glob<{ default: ImageMetadata }>(
  '/src/assets/notion/*.{jpeg,jpg,png,gif,webp}'
);

/**
 * Resolves a public/assets/notion string path (e.g. "/assets/notion/abc123.jpg")
 * to its Astro ImageMetadata module in src/assets/notion/ so that astro:assets
 * <Image /> can automatically generate modern WebP/AVIF, responsive srcset (1x, 2x),
 * and optimize dimensions with Sharp.
 */
export async function getNotionImageMetadata(
  src?: string | ImageMetadata | null
): Promise<ImageMetadata | null> {
  if (!src) return null;
  if (typeof src === 'object' && 'src' in src) {
    return src as ImageMetadata;
  }

  const filename = src.split('?')[0].split('/').pop();
  if (!filename) return null;

  const assetPath = `/src/assets/notion/${filename}`;
  if (allNotionImages[assetPath]) {
    const mod = await allNotionImages[assetPath]();
    return mod.default;
  }

  return null;
}
