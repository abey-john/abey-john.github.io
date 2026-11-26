import type * as maplibregl from 'maplibre-gl';
import type { RouteStyleState, TripData } from './types';
import {
  EMPTY_FEATURE_COLLECTION,
  LEAD_SOURCE_ID,
  ROUTE_SOURCE_ID,
  type TravelFeatureCollection
} from './map-style';

export interface RouteLeadPoint {
  coord: [number, number];
  haloRadius: number;
  haloOpacity: number;
}

let currentRouteGeoJSON: TravelFeatureCollection = EMPTY_FEATURE_COLLECTION;
let currentLeadGeoJSON: TravelFeatureCollection = EMPTY_FEATURE_COLLECTION;

export function getRouteGeoJSON(): TravelFeatureCollection {
  return currentRouteGeoJSON;
}

export function getLeadGeoJSON(): TravelFeatureCollection {
  return currentLeadGeoJSON;
}

export function syncRouteSources(map: maplibregl.Map | null): void {
  if (!map) return;
  const routeSource = map.getSource(ROUTE_SOURCE_ID) as
    maplibregl.GeoJSONSource | undefined;
  if (routeSource) {
    routeSource.setData(currentRouteGeoJSON);
  }
  const leadSource = map.getSource(LEAD_SOURCE_ID) as
    maplibregl.GeoJSONSource | undefined;
  if (leadSource) {
    leadSource.setData(currentLeadGeoJSON);
  }
}

export function resetRouteOverlayState(): void {
  currentRouteGeoJSON = EMPTY_FEATURE_COLLECTION;
  currentLeadGeoJSON = EMPTY_FEATURE_COLLECTION;
}

export function clearRouteOverlay(map: maplibregl.Map | null): void {
  resetRouteOverlayState();
  syncRouteSources(map);
}

export function updateRouteOverlay(
  map: maplibregl.Map | null,
  activeCoordinates: [number, number][] | null,
  style: RouteStyleState,
  leadPoint: RouteLeadPoint | null = null
): void {
  if (activeCoordinates && activeCoordinates.length >= 2) {
    currentRouteGeoJSON = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            color: style.color,
            glow: style.glow,
            mode: style.mode
          },
          geometry: {
            type: 'LineString',
            coordinates: activeCoordinates
          }
        }
      ]
    };
  } else {
    currentRouteGeoJSON = EMPTY_FEATURE_COLLECTION;
  }

  if (leadPoint) {
    currentLeadGeoJSON = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            color: style.color,
            haloRadius: leadPoint.haloRadius,
            haloOpacity: leadPoint.haloOpacity
          },
          geometry: {
            type: 'Point',
            coordinates: leadPoint.coord
          }
        }
      ]
    };
  } else {
    currentLeadGeoJSON = EMPTY_FEATURE_COLLECTION;
  }

  syncRouteSources(map);
}

export function calculateStopIndices(
  coords: [number, number][],
  stops: TripData['stops']
): number[] {
  if (!stops || stops.length === 0) return [];
  if (!coords || coords.length === 0) return stops.map(() => 0);
  if (stops.length === 1) return [0];

  const result: number[] = new Array(stops.length);
  result[0] = 0;
  result[stops.length - 1] = coords.length - 1;

  let searchFrom = 0;
  for (let s = 1; s < stops.length - 1; s++) {
    const stop = stops[s];
    let bestDist = Infinity;
    let bestIdx = searchFrom;

    for (let i = searchFrom; i < coords.length; i++) {
      const c = coords[i];
      const dx =
        (c[0] - stop.lng) * Math.cos(((c[1] + stop.lat) * Math.PI) / 360);
      const dy = c[1] - stop.lat;
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    result[s] = Math.max(searchFrom + 1, Math.min(coords.length - 1, bestIdx));
    searchFrom = result[s];
  }
  return result;
}

export function calculateCumulativeDistances(
  coords: [number, number][]
): number[] {
  const len = coords.length;
  const cumulative = new Array(len);
  cumulative[0] = 0;
  let total = 0;
  for (let i = 1; i < len; i++) {
    const p1 = coords[i - 1];
    const p2 = coords[i];
    const dx = (p2[0] - p1[0]) * Math.cos(((p1[1] + p2[1]) * Math.PI) / 360);
    const dy = p2[1] - p1[1];
    total += Math.hypot(dx, dy);
    cumulative[i] = total;
  }
  return cumulative;
}

function getPulseLeadPoint(
  coord: [number, number],
  elapsedMs: number
): RouteLeadPoint {
  const pulse = (elapsedMs % 1200) / 1200;
  return {
    coord,
    haloRadius: 5 + pulse * 13,
    haloOpacity: 0.55 * (1 - pulse)
  };
}

export function startRouteDrawAnimation(
  map: maplibregl.Map,
  coords: [number, number][],
  distanceMiles: number,
  style: RouteStyleState,
  tripCumulativeDistances: number[],
  callbacks: {
    getCurrentStopIndex: () => number;
    onUpdateCoords: (coords: [number, number][]) => void;
    onComplete: () => void;
  }
): number | null {
  const len = coords.length;
  if (!coords || len < 2) {
    callbacks.onUpdateCoords(coords);
    updateRouteOverlay(map, coords, style, null);
    return null;
  }

  const totalDist = tripCumulativeDistances[len - 1] || 0;
  const duration = Math.min(2600, Math.max(1800, 1600 + distanceMiles * 0.6));
  const startTime = performance.now();
  let animationId: number | null = null;

  function step(now: number) {
    if (callbacks.getCurrentStopIndex() !== -1) {
      currentLeadGeoJSON = EMPTY_FEATURE_COLLECTION;
      syncRouteSources(map);
      return;
    }

    const elapsed = now - startTime;
    const progress = Math.min(1, elapsed / duration);
    const ease = 0.5 - 0.5 * Math.cos(Math.PI * progress);
    const targetDist = totalDist * ease;

    if (progress >= 1) {
      if (callbacks.getCurrentStopIndex() === -1) {
        callbacks.onUpdateCoords(coords);
        updateRouteOverlay(map, coords, style, null);
      } else {
        currentLeadGeoJSON = EMPTY_FEATURE_COLLECTION;
        syncRouteSources(map);
      }
      callbacks.onComplete();
      return;
    }

    let low = 0;
    let high = len - 1;
    let segIdx = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (tripCumulativeDistances[mid] <= targetDist) {
        segIdx = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const p1 = coords[segIdx];
    const nextIdx = Math.min(segIdx + 1, len - 1);
    const p2 = coords[nextIdx];
    const d1 = tripCumulativeDistances[segIdx];
    const d2 = tripCumulativeDistances[nextIdx];
    const segSpan = d2 - d1;
    const t =
      segSpan > 0 ? Math.min(1, Math.max(0, (targetDist - d1) / segSpan)) : 0;

    const tipPoint: [number, number] = [
      p1[0] + (p2[0] - p1[0]) * t,
      p1[1] + (p2[1] - p1[1]) * t
    ];

    const currentSlice = coords.slice(0, segIdx + 1);
    currentSlice.push(tipPoint);
    callbacks.onUpdateCoords(currentSlice);
    updateRouteOverlay(
      map,
      currentSlice,
      style,
      getPulseLeadPoint(tipPoint, elapsed)
    );

    animationId = requestAnimationFrame(step);
  }

  const initialSlice: [number, number][] = [coords[0], coords[0]];
  callbacks.onUpdateCoords(initialSlice);
  updateRouteOverlay(map, initialSlice, style, getPulseLeadPoint(coords[0], 0));
  animationId = requestAnimationFrame(step);
  return animationId;
}

export function animateRouteSegment(
  map: maplibregl.Map,
  fromStopIdx: number,
  toStopIdx: number,
  fullTripCoordinates: [number, number][],
  currentTripStopIndices: number[],
  tripCumulativeDistances: number[],
  currentTripStops: TripData['stops'],
  style: RouteStyleState,
  callbacks: {
    onClosePopups: () => void;
    onUpdateCoords: (coords: [number, number][]) => void;
    activateStopMarker: (stop: TripData['stops'][0]) => void;
    onComplete: () => void;
  }
): number | null {
  const startVertex =
    fromStopIdx >= 0 && fromStopIdx < currentTripStopIndices.length
      ? currentTripStopIndices[fromStopIdx]
      : 0;
  const endVertex =
    toStopIdx < currentTripStopIndices.length
      ? currentTripStopIndices[toStopIdx]
      : fullTripCoordinates.length - 1;

  const destStop = currentTripStops[toStopIdx];
  callbacks.onClosePopups();

  if (startVertex >= endVertex) {
    const finalCoords = fullTripCoordinates.slice(0, endVertex + 1);
    callbacks.onUpdateCoords(finalCoords);
    updateRouteOverlay(map, finalCoords, style, null);
    if (destStop) {
      map.jumpTo({ center: [destStop.lng, destStop.lat] });
      callbacks.activateStopMarker(destStop);
    }
    callbacks.onComplete();
    return null;
  }

  const startDist = tripCumulativeDistances[startVertex] || 0;
  const endDist = tripCumulativeDistances[endVertex] || 0;
  const legDist = Math.max(0.001, endDist - startDist);
  const approxLegMiles = legDist * 69;

  const duration = Math.min(
    2500,
    Math.max(1200, 1050 + Math.sqrt(approxLegMiles) * 85)
  );
  const startTime = performance.now();

  const startZoom = map.getZoom();
  let targetZoom = 9.6;
  if (approxLegMiles > 250) {
    targetZoom = 7.8;
  } else if (approxLegMiles > 120) {
    targetZoom = 8.4;
  } else if (approxLegMiles > 60) {
    targetZoom = 9.0;
  }
  if (startZoom >= 8.5 && startZoom <= 11.5 && approxLegMiles <= 60) {
    targetZoom = startZoom;
  }

  const currentCenter = map.getCenter();
  let camLng = currentCenter.lng;
  let camLat = currentCenter.lat;

  const startCoord = fullTripCoordinates[startVertex];
  if (Math.hypot(camLng - startCoord[0], camLat - startCoord[1]) > 0.8) {
    camLng = startCoord[0];
    camLat = startCoord[1];
  }

  let lastTime = performance.now();
  let animationId: number | null = null;

  function step(now: number) {
    const elapsed = now - startTime;
    const progress = Math.min(1, elapsed / duration);
    const ease = 0.5 - 0.5 * Math.cos(Math.PI * progress);
    const targetDist = startDist + legDist * ease;
    const currentZoom = startZoom + (targetZoom - startZoom) * ease;

    if (progress >= 1) {
      const finalCoords = fullTripCoordinates.slice(0, endVertex + 1);
      callbacks.onUpdateCoords(finalCoords);
      updateRouteOverlay(map, finalCoords, style, null);

      if (destStop) {
        callbacks.activateStopMarker(destStop);
      }
      callbacks.onComplete();
      return;
    }

    let low = startVertex;
    let high = endVertex;
    let segIdx = startVertex;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (tripCumulativeDistances[mid] <= targetDist) {
        segIdx = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const p1 = fullTripCoordinates[segIdx];
    const nextIdx = Math.min(segIdx + 1, endVertex);
    const p2 = fullTripCoordinates[nextIdx];
    const d1 = tripCumulativeDistances[segIdx];
    const d2 = tripCumulativeDistances[nextIdx];
    const segSpan = d2 - d1;
    const t =
      segSpan > 0 ? Math.min(1, Math.max(0, (targetDist - d1) / segSpan)) : 0;

    const tipPoint: [number, number] = [
      p1[0] + (p2[0] - p1[0]) * t,
      p1[1] + (p2[1] - p1[1]) * t
    ];

    const currentSlice = fullTripCoordinates.slice(0, segIdx + 1);
    currentSlice.push(tipPoint);
    callbacks.onUpdateCoords(currentSlice);

    const dt = Math.min(50, Math.max(8, now - lastTime));
    lastTime = now;

    const smoothFactor = 1 - Math.exp(-dt * 0.007);
    camLng += (tipPoint[0] - camLng) * smoothFactor;
    camLat += (tipPoint[1] - camLat) * smoothFactor;

    let targetCamLng = camLng;
    let targetCamLat = camLat;
    const destLng = destStop ? destStop.lng : fullTripCoordinates[endVertex][0];
    const destLat = destStop ? destStop.lat : fullTripCoordinates[endVertex][1];

    if (progress > 0.8) {
      const settle = (progress - 0.8) / 0.2;
      const settleEase = settle * settle * (3 - 2 * settle);
      targetCamLng = camLng + (destLng - camLng) * settleEase;
      targetCamLat = camLat + (destLat - camLat) * settleEase;
    }

    map.jumpTo({
      center: [targetCamLng, targetCamLat],
      zoom: currentZoom
    });

    updateRouteOverlay(
      map,
      currentSlice,
      style,
      getPulseLeadPoint(tipPoint, elapsed)
    );

    animationId = requestAnimationFrame(step);
  }

  animationId = requestAnimationFrame(step);
  return animationId;
}
