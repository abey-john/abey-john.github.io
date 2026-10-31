import type { Loader, LoaderContext } from 'astro/loaders';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { NOTION_API_KEY, queryNotionDatabase } from './client';
import { geocodeLocation, simplifyCoordinates } from './geo';

export function notionTripsLoader(): Loader {
  return {
    name: 'notion-trips-loader',
    load: async ({ store, logger, parseData }: LoaderContext) => {
      const dbId = process.env.NOTION_TRIPS_DB_ID;

      if (NOTION_API_KEY && dbId) {
        try {
          // 1. Fetch places to cross-reference stop coordinates
          const placesDbId = process.env.NOTION_PLACES_DB_ID;
          const placesMap: {
            name: string;
            id: string;
            lat: number | null;
            lng: number | null;
            country: string;
            state: string;
          }[] = [];
          if (placesDbId) {
            try {
              const pResults = await queryNotionDatabase(placesDbId);
              for (const p of pResults) {
                const name = (p.properties.Name?.title?.[0]?.plain_text || '').trim();
                const lat =
                  typeof p.properties.Latitude?.number === 'number'
                    ? p.properties.Latitude.number
                    : null;
                const lng =
                  typeof p.properties.Longitude?.number === 'number'
                    ? p.properties.Longitude.number
                    : null;
                const country = (
                  p.properties.Country?.rich_text?.[0]?.plain_text ||
                  p.properties.Country?.select?.name ||
                  ''
                ).trim();
                const state = (
                  p.properties.State?.rich_text?.[0]?.plain_text ||
                  p.properties.State?.select?.name ||
                  ''
                ).trim();
                if (name) {
                  placesMap.push({ name, id: p.id, lat, lng, country, state });
                }
              }
            } catch (err: any) {
              logger.warn(`Could not load places for trip stop matching: ${err.message}`);
            }
          }

          // 2. Fetch Trips from Notion
          const tripResults = await queryNotionDatabase(dbId);

          store.clear();

          const normalizePlaceName = (str: string): string => {
            return (str || '')
              .toLowerCase()
              .normalize('NFD')
              .replace(/[\u0300-\u036f]/g, '')
              .replace(/\b(national park|state park|monument|preserve|np|city)\b/gi, '')
              .replace(/[^a-z0-9]/g, '')
              .trim();
          };

          for (const page of tripResults) {
            const p = page.properties;
            const name = p.Name?.title?.[0]?.plain_text || 'Untitled Trip';
            const id = page.id;
            const summary = p.Summary?.rich_text?.[0]?.plain_text || '';
            const date = p.Date?.rich_text?.[0]?.plain_text || p.Date?.date?.start || '';
            const color = p.Color?.select?.name || p.Color?.rich_text?.[0]?.plain_text || 'Amber';
            const rawType =
              p.Type?.select?.name ||
              p.Type?.rich_text?.[0]?.plain_text ||
              p.type?.select?.name ||
              p.type?.rich_text?.[0]?.plain_text ||
              p.Mode?.select?.name ||
              p.Mode?.rich_text?.[0]?.plain_text ||
              p['Trip Type']?.select?.name ||
              p['Trip Type']?.rich_text?.[0]?.plain_text ||
              '';
            const routeRaw = p.Route?.rich_text?.[0]?.plain_text || '';

            // Determine travel mode ('drive', 'train', 'flight')
            // Priority 1: Explicit Notion "Type" property (authoritative)
            // Priority 2: Fallback to trip Name only if Type is not provided
            let mode: 'drive' | 'train' | 'flight' = 'drive';
            const typeLower = rawType.toLowerCase().trim();
            const nameLower = name.toLowerCase().trim();

            if (typeLower) {
              if (/\b(?:train|rail|railway|railroad|transit|amtrak|eurail)\b/i.test(typeLower)) {
                mode = 'train';
              } else if (/\b(?:flight|fly|plane|flying|airline|air)\b/i.test(typeLower)) {
                mode = 'flight';
              } else {
                mode = 'drive';
              }
            } else {
              // Fallback inference if Type was left empty in Notion
              if (/\b(?:train|railway|railroad|amtrak|eurail)\b/i.test(nameLower)) {
                mode = 'train';
              } else if (/\b(?:flight|fly|plane|flying)\b/i.test(nameLower)) {
                mode = 'flight';
              } else {
                mode = 'drive';
              }
            }

            // Split into stop tokens
            const stopTokens = routeRaw
              .split(/(?:->|>|,|\r?\n)+/)
              .map((s: string) => s.trim())
              .filter(Boolean);

            const waypoints: {
              name: string;
              placeId?: string;
              lat: number;
              lng: number;
              isWaypoint: boolean;
            }[] = [];

            for (const rawToken of stopTokens) {
              const isVia =
                /^(?:via[:\s]+|\((?:via[:\s]+)?)/i.test(rawToken) || rawToken.startsWith('(');
              const cleanToken = rawToken
                .replace(/^(?:via[:\s]+|\((?:via[:\s]+)?)/i, '')
                .replace(/^\(|\)$/g, '')
                .trim();
              const normToken = normalizePlaceName(cleanToken);
              // 1. Exact normalized match first (e.g. "Grand Canyon West" matches "Grand Canyon West")
              let matched = placesMap.find((pl) => normalizePlaceName(pl.name) === normToken);

              // 2. Best containment match (e.g. "Grand Canyon" matches "Grand Canyon National Park", but not vice-versa)
              if (!matched) {
                const candidates = placesMap.filter((pl) => {
                  const normPlace = normalizePlaceName(pl.name);
                  return normPlace.includes(normToken) && normToken.length >= 3;
                });
                if (candidates.length > 0) {
                  candidates.sort((a, b) => {
                    const diffA = Math.abs(normalizePlaceName(a.name).length - normToken.length);
                    const diffB = Math.abs(normalizePlaceName(b.name).length - normToken.length);
                    return diffA - diffB;
                  });
                  matched = candidates[0];
                }
              }

              if (matched) {
                if (
                  matched.lat === null ||
                  matched.lng === null ||
                  (matched.lat === 0 && matched.lng === 0)
                ) {
                  const geocoded = await geocodeLocation(
                    matched.name,
                    matched.country,
                    matched.state
                  );
                  if (geocoded) {
                    matched.lat = geocoded.lat;
                    matched.lng = geocoded.lng;
                  }
                }
                if (matched.lat !== null && matched.lng !== null) {
                  waypoints.push({
                    name: matched.name,
                    placeId: matched.id,
                    lat: matched.lat,
                    lng: matched.lng,
                    isWaypoint: isVia,
                  });
                }
              } else {
                // Fallback: Geocode globally if stop isn't in places DB
                const geocoded = await geocodeLocation(cleanToken);
                if (geocoded) {
                  waypoints.push({
                    name: cleanToken,
                    lat: geocoded.lat,
                    lng: geocoded.lng,
                    isWaypoint: isVia,
                  });
                } else {
                  logger.warn(
                    `Could not resolve coordinates for stop "${cleanToken}" in trip "${name}".`
                  );
                }
              }
            }

            // Real destination stops exclude pass-through waypoints
            const stops = waypoints
              .filter((w) => !w.isWaypoint)
              .map(({ isWaypoint, ...rest }) => rest);

            const routingPoints = waypoints.map(({ lat, lng }) => ({ lat, lng }));

            // Calculate or load cached route geometry
            let geometry: { type: 'LineString'; coordinates: [number, number][] } = {
              type: 'LineString',
              coordinates: (routingPoints.length > 0 ? routingPoints : stops).map((s) => [
                s.lng,
                s.lat,
              ]),
            };
            let distanceMiles = 0;
            let durationHours = 0;

            if (routingPoints.length >= 2) {
              const cacheDir = path.resolve('src/assets/notion/routes');
              if (!fs.existsSync(cacheDir)) {
                fs.mkdirSync(cacheDir, { recursive: true });
              }
              const cacheFile = path.join(cacheDir, `${id}.json`);
              const coordsKey = routingPoints
                .map((s) => `${s.lng.toFixed(4)},${s.lat.toFixed(4)}`)
                .join(';');
              const hash = crypto.createHash('md5').update(`${mode}:${coordsKey}`).digest('hex');
              const legacyHash = crypto.createHash('md5').update(coordsKey).digest('hex');

              let cachedData: any = null;
              if (fs.existsSync(cacheFile)) {
                try {
                  const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
                  if (
                    (c.hash === hash || (c.hash === legacyHash && (!c.mode || c.mode === mode))) &&
                    (!c.mode || c.mode === mode) &&
                    c.geometry?.coordinates?.length
                  ) {
                    cachedData = c;
                  }
                } catch {}
              }

              if (cachedData) {
                geometry = cachedData.geometry;
                distanceMiles = cachedData.distanceMiles || 0;
                durationHours = cachedData.durationHours || 0;
              } else if (mode === 'train') {
                // Automated railway routing with valley corridor fallback for isolated rail sections
                try {
                  let totalMeters = 0;
                  let totalSeconds = 0;
                  const allCoords: [number, number][] = [];

                  for (let i = 0; i < routingPoints.length - 1; i++) {
                    const from = routingPoints[i];
                    const to = routingPoints[i + 1];

                    let legCoords: [number, number][] | null = null;
                    let legMeters = 0;
                    let legSeconds = 0;

                    // 1. For train tours: Try BRouter railway routing
                    if (mode === 'train') {
                      try {
                        const brouterUrl = `https://brouter.de/brouter?lonlats=${from.lng},${from.lat}|${to.lng},${to.lat}&profile=rail&format=geojson`;
                        const bRes = await fetch(brouterUrl, {
                          headers: { 'User-Agent': 'PersonalWebsite/1.0' },
                        });
                        if (bRes.ok) {
                          const bData = await bRes.json();
                          const feat = bData.features?.[0];
                          const coords = feat?.geometry?.coordinates;
                          if (coords && coords.length > 0) {
                            legCoords = coords as [number, number][];
                            legMeters = Number(feat.properties?.['track-length'] || 0);
                            legSeconds = Number(feat.properties?.['total-time'] || 0);
                          }
                        }
                      } catch {}
                    }

                    // 2. Try standard road driving routing fallback (OSRM)
                    if (!legCoords) {
                      try {
                        const osrmLegUrl = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
                        const oRes = await fetch(osrmLegUrl);
                        if (oRes.ok) {
                          const oData = await oRes.json();
                          const r = oData.routes?.[0];
                          if (r?.geometry?.coordinates?.length) {
                            legCoords = r.geometry.coordinates as [number, number][];
                            legMeters = Number(r.distance || 0);
                            legSeconds = Number(r.duration || 0);
                          }
                        }
                      } catch {}
                    }

                    // 3. Straight line fallback if all network routing fails
                    if (!legCoords) {
                      legCoords = [
                        [from.lng, from.lat],
                        [to.lng, to.lat],
                      ];
                    }

                    // 4. Ensure leg accurately connects to the exact from and to coordinates
                    if (legCoords && legCoords.length > 0) {
                      const startPt = legCoords[0];
                      const endPt = legCoords[legCoords.length - 1];
                      if (Math.hypot(startPt[0] - from.lng, startPt[1] - from.lat) > 0.004) {
                        legCoords.unshift([from.lng, from.lat]);
                      }
                      if (Math.hypot(endPt[0] - to.lng, endPt[1] - to.lat) > 0.004) {
                        legCoords.push([to.lng, to.lat]);
                      }
                    }

                    totalMeters += legMeters;
                    totalSeconds += legSeconds;
                    if (allCoords.length > 0) {
                      allCoords.push(...legCoords.slice(1));
                    } else {
                      allCoords.push(...legCoords);
                    }
                  }

                  if (allCoords.length > 1) {
                    distanceMiles = Math.round((totalMeters / 1609.34) * 10) / 10;
                    durationHours = Math.round((totalSeconds / 3600) * 10) / 10;
                    const simplified = simplifyCoordinates(allCoords, 0.0001).map(
                      ([lng, lat]) =>
                        [
                          Math.round(lng * 100000) / 100000,
                          Math.round(lat * 100000) / 100000,
                        ] as [number, number]
                    );
                    geometry = {
                      type: 'LineString',
                      coordinates: simplified,
                    };
                    fs.writeFileSync(
                      cacheFile,
                      JSON.stringify(
                        { hash, distanceMiles, durationHours, mode: 'train', geometry },
                        null,
                        2
                      )
                    );
                    logger.info(
                      `Fetched rail route for "${name}": ${distanceMiles} mi, ${geometry.coordinates.length} points.`
                    );
                  }
                } catch (err: any) {
                  logger.warn(
                    `Failed fetching rail route for "${name}": ${err.message}. Using straight lines.`
                  );
                }
              } else if (mode === 'drive') {
                // Fetch from OSRM driving with retries
                try {
                  const coordsParam = routingPoints.map((s) => `${s.lng},${s.lat}`).join(';');
                  const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${coordsParam}?overview=full&geometries=geojson`;

                  let osrmData: any = null;
                  for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                      const res = await fetch(osrmUrl, {
                        headers: { 'User-Agent': 'PersonalWebsite/1.0' },
                      });
                      if (res.ok) {
                        const data = await res.json();
                        if (data.code === 'Ok' && data.routes?.[0]) {
                          osrmData = data;
                          break;
                        }
                      }
                    } catch (e) {
                      if (attempt === 3) throw e;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
                  }

                  if (osrmData?.routes?.[0]) {
                    const r = osrmData.routes[0];
                    distanceMiles = Math.round((r.distance / 1609.34) * 10) / 10;
                    durationHours = Math.round((r.duration / 3600) * 10) / 10;

                    const rawCoords = r.geometry.coordinates as [number, number][];
                    const simplified = simplifyCoordinates(rawCoords, 0.0001).map(
                      ([lng, lat]) =>
                        [
                          Math.round(lng * 100000) / 100000,
                          Math.round(lat * 100000) / 100000,
                        ] as [number, number]
                    );

                    geometry = {
                      type: 'LineString',
                      coordinates: simplified,
                    };

                    fs.writeFileSync(
                      cacheFile,
                      JSON.stringify(
                        {
                          hash,
                          distanceMiles,
                          durationHours,
                          mode: 'drive',
                          geometry,
                        },
                        null,
                        2
                      )
                    );
                    logger.info(
                      `Fetched road route for "${name}": ${distanceMiles} mi, ${geometry.coordinates.length} points.`
                    );
                  } else {
                    // Fallback to BRouter car-fast if OSRM was unreachable or returned error
                    try {
                      const brouterPoints = routingPoints.map((s) => `${s.lng},${s.lat}`).join('|');
                      const brouterUrl = `https://brouter.de/brouter?lonlats=${brouterPoints}&profile=car-fast&format=geojson`;
                      const bRes = await fetch(brouterUrl, {
                        headers: { 'User-Agent': 'PersonalWebsite/1.0' },
                      });
                      if (bRes.ok) {
                        const bData = await bRes.json();
                        const feat = bData.features?.[0];
                        if (feat?.geometry?.coordinates?.length) {
                          const legCoords = feat.geometry.coordinates as [number, number][];
                          const legMeters = Number(feat.properties?.['track-length'] || 0);
                          const legSeconds = Number(feat.properties?.['total-time'] || 0);
                          distanceMiles = Math.round((legMeters / 1609.34) * 10) / 10;
                          durationHours = Math.round((legSeconds / 3600) * 10) / 10;
                          const simplified = simplifyCoordinates(legCoords, 0.0001).map(
                            ([lng, lat]) =>
                              [
                                Math.round(lng * 100000) / 100000,
                                Math.round(lat * 100000) / 100000,
                              ] as [number, number]
                          );
                          geometry = {
                            type: 'LineString',
                            coordinates: simplified,
                          };
                          fs.writeFileSync(
                            cacheFile,
                            JSON.stringify(
                              {
                                hash,
                                distanceMiles,
                                durationHours,
                                mode: 'drive',
                                geometry,
                              },
                              null,
                              2
                            )
                          );
                          logger.info(
                            `Fetched road route via BRouter fallback for "${name}": ${distanceMiles} mi, ${geometry.coordinates.length} points.`
                          );
                        }
                      }
                    } catch (bErr: any) {
                      logger.warn(`BRouter fallback also failed for "${name}": ${bErr.message}`);
                    }
                  }
                } catch (err: any) {
                  logger.warn(
                    `Failed fetching OSRM road route for "${name}": ${err.message}. Using straight lines.`
                  );
                }
              }

              // Also ensure cached geometry is simplified if it was saved unsimplified
              if (geometry.coordinates.length > 5000) {
                geometry.coordinates = simplifyCoordinates(geometry.coordinates, 0.0001).map(
                  ([lng, lat]) => [
                    Math.round(lng * 100000) / 100000,
                    Math.round(lat * 100000) / 100000,
                  ]
                );
              }
            }

            const tripItem = {
              id,
              name,
              summary: summary || undefined,
              date: date || undefined,
              color,
              mode,
              stops,
              distanceMiles,
              durationHours,
              geometry,
            };

            const data = await parseData({ id, data: tripItem });
            store.set({ id, data });
          }

          logger.info(`Loaded ${tripResults.length} trips from Notion.`);
          return;
        } catch (err: any) {
          logger.warn(`Failed loading trips from Notion: ${err.message}.`);
        }
      }

      logger.warn(
        'No trips loaded from Notion. Ensure NOTION_API_KEY and NOTION_TRIPS_DB_ID are configured.'
      );
      store.clear();
    },
  };
}
