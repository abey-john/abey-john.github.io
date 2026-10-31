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
  notionTripsLoader,
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
    url: z.string(),
    role: z.string(),
    date: z.string().optional(),
    image: z.string().optional(),
    order: z.number().default(0),
  }),
});

const places = defineCollection({
  loader: notionPlacesLoader(),
  schema: z.object({
    id: z.string(),
    name: z.string(),
    type: z.enum(['city', 'park', 'landmark', 'venue']),
    lat: z.number(),
    lng: z.number(),
    country: z.string(),
    state: z.string().optional(),
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
          previewUrl: z.string().optional(),
          previewTrack: z.string().optional(),
          spotifyUrl: z.string().optional(),
          appleMusicUrl: z.string().optional(),
          bandcampUrl: z.string().optional(),
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
      previewUrl: z.string().optional(),
      previewTrack: z.string().optional(),
      spotifyUrl: z.string().optional(),
      appleMusicUrl: z.string().optional(),
      bandcampUrl: z.string().optional(),
    }),
    recentListen: z.object({
      title: z.string(),
      artist: z.string(),
      cover: z.string(),
      rating: z.number().max(siteConfig.ratingMax),
      blurb: z.string().optional(),
      note: z.string().optional(),
      date: z.string().optional(),
      previewUrl: z.string().optional(),
      previewTrack: z.string().optional(),
      spotifyUrl: z.string().optional(),
      appleMusicUrl: z.string().optional(),
      bandcampUrl: z.string().optional(),
    }),
    vinyl: z
      .array(
        z.object({
          title: z.string(),
          artist: z.string(),
          cover: z.string(),
          previewUrl: z.string().optional(),
          previewTrack: z.string().optional(),
        })
      )
      .default([]),
  }),
});

const settings = defineCollection({
  loader: notionSettingsLoader(),
  schema: z.object({
    name: z.string(),
    role: z.string(),
    location: z.string(),
    timezone: z.string().default('America/Los_Angeles'),
    email: z.string(),
    github: z.string(),
    linkedin: z.string(),
    ratingMax: z.number().default(10),
    description: z.string().optional(),
  }),
});

const trips = defineCollection({
  loader: notionTripsLoader(),
  schema: z.object({
    id: z.string(),
    name: z.string(),
    summary: z.string().optional(),
    date: z.string().optional(),
    color: z.string().default('Amber'),
    mode: z.enum(['drive', 'train', 'flight']).default('drive'),
    stops: z.array(
      z.object({
        name: z.string(),
        placeId: z.string().optional(),
        lat: z.number(),
        lng: z.number(),
      })
    ),
    distanceMiles: z.number().default(0),
    durationHours: z.number().default(0),
    geometry: z.object({
      type: z.literal('LineString'),
      coordinates: z.array(z.tuple([z.number(), z.number()])),
    }),
  }),
});

export const collections = {
  about,
  now,
  launches,
  places,
  music,
  settings,
  trips,
};
