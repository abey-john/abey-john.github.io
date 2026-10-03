import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { siteConfig } from './config';
import {
  notionAboutLoader,
  notionNowLoader,
  notionLaunchesLoader,
  notionPlacesLoader,
  notionMusicLoader,
  notionSettingsLoader,
} from './loaders/notion';

const about = defineCollection({
  loader: notionAboutLoader(),
  schema: z.object({
    title: z.string().optional(),
    photo: z.string().optional(),
    photoCaption: z.string().optional(),
    photoAlt: z.string().optional(),
    avatar: z.string().optional(),
  }),
});

const now = defineCollection({
  loader: notionNowLoader(),
  schema: z.object({
    updated: z.coerce.date(),
  }),
});

const launches = defineCollection({
  loader: notionLaunchesLoader(),
  schema: z.object({
    id: z.string(),
    category: z.enum(['professional', 'personal']).default('professional'),
    title: z.string(),
    url: z.url(),
    role: z.string(),
    date: z.string().optional(),
    image: z.string().optional(),
  }),
});

const places = defineCollection({
  loader: notionPlacesLoader(),
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
  loader: notionMusicLoader(),
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
      blurb: z.string().optional(),
      note: z.string().optional(),
      date: z.string().optional(),
    }),
    recentListen: z.object({
      title: z.string(),
      artist: z.string(),
      cover: z.string(),
      rating: z.number().max(siteConfig.ratingMax),
      blurb: z.string().optional(),
      note: z.string().optional(),
      date: z.string().optional(),
    }),
  }),
});

const settings = defineCollection({
  loader: notionSettingsLoader(),
  schema: z.object({
    name: z.string(),
    role: z.string(),
    location: z.string(),
    email: z.string(),
    github: z.string(),
    linkedin: z.string(),
    ratingMax: z.number().default(10),
    description: z.string().optional(),
  }),
});

export const collections = {
  about,
  now,
  launches,
  places,
  music,
  settings,
};
