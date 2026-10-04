// @ts-check
import { defineConfig, sharpImageService } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  site: 'https://abey-john.github.io',
  image: {
    service: sharpImageService({
      webp: { quality: 85 },
      jpeg: { quality: 85 },
      png: { quality: 90 },
      avif: { quality: 80 },
    }),
  },
});
