import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { glob, file } from 'astro/loaders';
import { siteConfig } from './config';

const about = defineCollection({
  loader: glob({ pattern: '*.md', base: 'src/content/about' }),
  schema: z.object({
    title: z.string().optional(),
  }),
});

const now = defineCollection({
  loader: glob({ pattern: '*.md', base: 'src/content/now' }),
  schema: z.object({
    updated: z.coerce.date(),
  }),
});

const launches = defineCollection({
  loader: file('src/data/launches.json'),
  schema: z.object({
    id: z.string(),
    category: z.enum(['professional', 'personal']).default('professional'),
    title: z.string(),
    url: z.url(),
    role: z.string(),
    date: z.string().optional(),
  }),
});

const places = defineCollection({
  loader: file('src/data/places.json'),
  schema: z.object({
    id: z.string(),
    name: z.string(),
    type: z.enum(['city', 'park']),
    lat: z.number(),
    lng: z.number(),
    country: z.string(),
    blurb: z.string().optional(),
    photo: z.string().optional(),
    link: z.string().optional(),
  }),
});

const music = defineCollection({
  loader: file('src/data/music.json'),
  schema: z.object({
    updated: z.coerce.date(),
    favorites: z
      .array(
        z.object({
          title: z.string(),
          artist: z.string(),
          cover: z.string(),
          blurb: z.string().optional().default(''),
        })
      )
      .length(10),
    recommendation: z.object({
      title: z.string(),
      artist: z.string(),
      cover: z.string(),
      rating: z.number().max(siteConfig.ratingMax),
      note: z.string().optional(),
      date: z.string().optional(),
    }),
    recentListen: z.object({
      title: z.string(),
      artist: z.string(),
      cover: z.string(),
      rating: z.number().max(siteConfig.ratingMax),
      note: z.string().optional(),
      date: z.string().optional(),
    }),
  }),
});

export const collections = {
  about,
  now,
  launches,
  places,
  music,
};
