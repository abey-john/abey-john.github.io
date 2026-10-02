# Abey John — Personal Site

A personal website built with Astro and TypeScript.

## Getting Started

### Development
```bash
npm run dev
```

### Build
```bash
npm run build
```

### Preview
```bash
npm run preview
```

### Type Checking & Audits
```bash
npm run check              # Astro type check
npm run check:placeholders # Audit unresolved PLACEHOLDER: text
npm run check:exif         # Verify no images contain EXIF/GPS metadata
npm run strip:exif         # Strip EXIF metadata from all assets
```

## Content Structure

All site content is separated from page layouts:
- `src/config.ts`: Global metadata (name, role, social links, ratings scale).
- `src/content/`: Content collections with schema validation.
- `src/data/`: Structured JSON data for launches, places, and music.
- `src/assets/`: Local static assets.

## Image Pipeline & Privacy

Images live inside the repository and are processed at build time via Astro's image service to eliminate layout shifts.

### Folder Conventions
- `src/assets/covers/`: Album artwork (1:1 square, recommended ~600x600px to ~1000x1000px).
- `src/assets/photos/`: Travel photography (3:2 or 4:3 landscape, recommended ~1200x800px max width).
- **Naming**: Lowercase kebab-case (e.g. `artist-album-title.jpg`, `country-location-name.jpg`).

### EXIF & GPS Safety
Photos must never be committed with embedded location metadata (EXIF GPS):
1. **Strip metadata**: Run `npm run strip:exif` before committing new images.
2. **Verify cleanliness**: Run `npm run check:exif`. This check will fail if any asset contains EXIF metadata.
3. **Optional Git hook**: Add `npm run check:exif` to `.git/hooks/pre-commit` to prevent committing unstripped assets.

## Travel Map & Basemaps

The travel page uses **Leaflet** (`leaflet`) as an isolated client-side island:
- **Library**: Leaflet (`leaflet` ~40KB gzipped) chosen for minimal overhead, zero WebGL baggage, and pure client-side execution.
- **Tiles**: OpenStreetMap standard tile layer (`https://tile.openstreetmap.org/{z}/{x}/{y}.png`).
- **Attribution & Terms**: Free for low-traffic personal sites with zero API keys or accounts required. Required attribution:
  `© OpenStreetMap contributors`. Dark mode styling is handled via custom CSS tile filtering.
- **Privacy**: Coordinates in `src/data/places.json` are strictly city or park center level—never residential, workplace, or private lodging coordinates.
