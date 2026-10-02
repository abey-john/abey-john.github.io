import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { glob, file } from 'astro/loaders';
import { siteConfig } from './config';

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
    title: z.string(),
    url: z.url(),
    role: z.string(),
    date: z.string().optional(),
  }),
});

const places = defineCollection({
  loader: file('src/data/places.json'),
  schema: ({ image }) =>
    z.object({
      id: z.string(),
      name: z.string(),
      type: z.enum(['city', 'park']),
      lat: z.number(),
      lng: z.number(),
      country: z.string(),
      blurb: z.string().optional(),
      photo: image().optional(),
      link: z.string().optional(),
    }),
});

const music = defineCollection({
  loader: file('src/data/music.json'),
  schema: ({ image }) =>
    z.object({
      favorites: z
        .array(
          z.object({
            title: z.string(),
            artist: z.string(),
            cover: image(),
            blurb: z.string(),
          })
        )
        .length(10),
      recommendation: z.object({
        title: z.string(),
        artist: z.string(),
        cover: image(),
        rating: z.number().max(siteConfig.ratingMax),
        note: z.string().optional(),
        date: z.string(),
      }),
      recentListen: z.object({
        title: z.string(),
        artist: z.string(),
        cover: image(),
        rating: z.number().max(siteConfig.ratingMax),
        note: z.string().optional(),
        date: z.string(),
      }),
    }),
});

export const collections = {
  now,
  launches,
  places,
  music,
};
