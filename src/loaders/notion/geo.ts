/**
 * In-memory cache of geocoded coordinates to avoid redundant network calls.
 */
const geocodeCache = new Map<string, { lat: number; lng: number }>();

/**
 * Infer latitude and longitude from location name, country, and optional state using Open-Meteo with OpenStreetMap fallback.
 */
export async function geocodeLocation(
  name: string,
  country?: string,
  state?: string
): Promise<{ lat: number; lng: number } | null> {
  const cacheKey = `${name.toLowerCase().trim()}|${(state || '').toLowerCase().trim()}|${(country || '').toLowerCase().trim()}`;
  if (geocodeCache.has(cacheKey)) {
    return geocodeCache.get(cacheKey)!;
  }

  // 1. Try Open-Meteo Geocoding API (fast, worldwide, free, no API key required)
  try {
    const cleanName = name.replace(/,.*$/, '').trim();
    const searchUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cleanName || name)}&count=10&language=en&format=json`;
    const res = await fetch(searchUrl);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.results) && data.results.length > 0) {
        let match = data.results[0];
        const countryLower = (country || '').toLowerCase().trim();
        const stateLower = (state || '').toLowerCase().trim();

        const matchesCountry = (r: any) =>
          !countryLower ||
          r.country?.toLowerCase().includes(countryLower) ||
          countryLower.includes(r.country?.toLowerCase());

        const matchesState = (r: any) =>
          !stateLower ||
          r.admin1?.toLowerCase().includes(stateLower) ||
          stateLower.includes(r.admin1?.toLowerCase());

        if (stateLower && countryLower) {
          const exactBoth = data.results.find(
            (r: any) => matchesCountry(r) && matchesState(r)
          );
          if (exactBoth) {
            match = exactBoth;
          } else {
            const stateOnly = data.results.find((r: any) => matchesState(r));
            const countryOnly = data.results.find((r: any) =>
              matchesCountry(r)
            );
            if (stateOnly) match = stateOnly;
            else if (countryOnly) match = countryOnly;
          }
        } else if (stateLower) {
          const foundState = data.results.find((r: any) => matchesState(r));
          if (foundState) match = foundState;
        } else if (countryLower) {
          const foundCountry = data.results.find((r: any) => matchesCountry(r));
          if (foundCountry) match = foundCountry;
        }

        const coords = {
          lat: Number(match.latitude),
          lng: Number(match.longitude)
        };
        geocodeCache.set(cacheKey, coords);
        return coords;
      }
    }
  } catch {
    // Proceed to fallback
  }

  // 2. Fallback to OpenStreetMap Nominatim
  try {
    const query = [name, state, country].filter(Boolean).join(', ');
    const searchUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': 'PersonalWebsiteGeocoding/1.0' }
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        const coords = {
          lat: parseFloat(data[0].lat),
          lng: parseFloat(data[0].lon)
        };
        geocodeCache.set(cacheKey, coords);
        return coords;
      }
    }
  } catch {
    // Geocode failed
  }

  return null;
}

/**
 * Ramer-Douglas-Peucker line simplification algorithm.
 */
export function simplifyCoordinates(
  points: [number, number][],
  tolerance = 0.0001
): [number, number][] {
  if (points.length <= 2) return points;
  let maxDist = 0;
  let index = 0;
  const [x1, y1] = points[0];
  const [x2, y2] = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const num = Math.abs((y2 - y1) * x - (x2 - x1) * y + x2 * y1 - y2 * x1);
    const den = Math.hypot(y2 - y1, x2 - x1);
    const d = den === 0 ? Math.hypot(x - x1, y - y1) : num / den;
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }
  if (maxDist > tolerance) {
    const left = simplifyCoordinates(points.slice(0, index + 1), tolerance);
    const right = simplifyCoordinates(points.slice(index), tolerance);
    return left.slice(0, -1).concat(right);
  }
  return [points[0], points[points.length - 1]];
}
