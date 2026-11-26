import * as maplibregl from 'maplibre-gl';
import type { RouteStyleState, TripData } from './types';
import {
  EMPTY_FEATURE_COLLECTION,
  ROUTE_SOURCE_ID,
  getEffectiveMapTheme,
  getRouteCasingColor,
  type TravelFeatureCollection
} from './map-style';

interface RouteLeadPoint {
  coord: [number, number];
  haloRadius: number;
  haloOpacity: number;
}

interface ActiveDrawFrame {
  coords: [number, number][];
  endIdx: number;
  tipPoint: [number, number] | null;
  style: RouteStyleState;
  leadPulse: RouteLeadPoint | null;
}

interface StagedRouteKey {
  coordsRef: [number, number][];
  sliceLength: number;
  color: string;
  mode: string;
}

let currentRouteGeoJSON: TravelFeatureCollection = EMPTY_FEATURE_COLLECTION;
let currentRouteOpacity = 1;
let lastStagedKey: StagedRouteKey | null = null;

let drawCanvas: HTMLCanvasElement | null = null;
let drawCtx: CanvasRenderingContext2D | null = null;
let canvasResizeObserver: ResizeObserver | null = null;
let cssWidth = 0;
let cssHeight = 0;
let dpr = 1;

let activeDrawFrame: ActiveDrawFrame | null = null;
let renderListener: (() => void) | null = null;
let pendingSourceDataListener:
  ((e: maplibregl.MapSourceDataEvent) => void) | null = null;
let pendingHandoffTimer: number | null = null;
let handoffToken = 0;

const scratchLngLat = new maplibregl.LngLat(0, 0);

export function getRouteGeoJSON(): TravelFeatureCollection {
  return currentRouteGeoJSON;
}

export function getCurrentRouteOpacity(): number {
  return currentRouteOpacity;
}

function setWebGLRouteOpacity(
  map: maplibregl.Map | null,
  opacity: number
): void {
  currentRouteOpacity = opacity;
  if (!map) return;
  try {
    map.setGlobalStateProperty('routeOpacity', opacity);
  } catch (e) {
    // Ignore if style is not yet ready; applied again on load/style sync
  }
}

function updateCanvasBackingSize(mapEl: HTMLElement): void {
  if (!drawCanvas) return;
  cssWidth = mapEl.clientWidth;
  cssHeight = mapEl.clientHeight;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  const nextWidth = Math.max(1, Math.round(cssWidth * dpr));
  const nextHeight = Math.max(1, Math.round(cssHeight * dpr));
  if (drawCanvas.width !== nextWidth || drawCanvas.height !== nextHeight) {
    drawCanvas.width = nextWidth;
    drawCanvas.height = nextHeight;
  }
}

function clearDrawCanvas(): void {
  if (!drawCanvas || !drawCtx) return;
  drawCtx.setTransform(1, 0, 0, 1, 0, 0);
  drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  if (drawCanvas.style.display !== 'none') {
    drawCanvas.style.display = 'none';
  }
}

function cancelPendingHandoff(map: maplibregl.Map | null): void {
  ++handoffToken;
  if (pendingHandoffTimer !== null) {
    window.clearTimeout(pendingHandoffTimer);
    pendingHandoffTimer = null;
  }
  if (map && pendingSourceDataListener) {
    map.off('sourcedata', pendingSourceDataListener);
  }
  pendingSourceDataListener = null;
}

interface MapWithTransform extends maplibregl.Map {
  transform?: {
    isLocationOccluded?: (lngLat: maplibregl.LngLat) => boolean;
  };
}

function isLocationOccluded(
  map: maplibregl.Map,
  lng: number,
  lat: number
): boolean {
  scratchLngLat.lng = lng;
  scratchLngLat.lat = lat;
  const transform = (map as MapWithTransform).transform;
  if (transform && typeof transform.isLocationOccluded === 'function') {
    return transform.isLocationOccluded(scratchLngLat);
  }
  return false;
}

function renderActiveDrawFrame(map: maplibregl.Map): void {
  if (!activeDrawFrame || !drawCanvas || !drawCtx) return;
  if (cssWidth === 0 || cssHeight === 0) return;

  const { coords, endIdx, tipPoint, style, leadPulse } = activeDrawFrame;
  const maxIdx = Math.min(endIdx, coords.length - 1);
  if (maxIdx < 0) {
    clearDrawCanvas();
    return;
  }

  if (drawCanvas.style.display !== 'block') {
    drawCanvas.style.display = 'block';
  }

  const ctx = drawCtx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const zoom = map.getZoom();
  const t2_4 = Math.max(0, Math.min(1, (zoom - 2) / 2));
  const t4_12 = Math.max(0, Math.min(1, (zoom - 4) / 8));
  const lineWidth = zoom <= 4 ? 2.2 + t2_4 * 0.6 : 2.8 + t4_12 * 3.2;
  const casingWidth = zoom <= 4 ? 4.2 + t2_4 * 1.1 : 5.3 + t4_12 * 3.2;
  const glowWidth = zoom <= 4 ? 6.0 + t2_4 * 1.5 : 7.5 + t4_12 * 7.5;

  const margin = Math.max(48, glowWidth * 2);
  const minX = -margin;
  const maxX = cssWidth + margin;
  const minY = -margin;
  const maxY = cssHeight + margin;

  const path = new Path2D();
  let hasPrev = false;
  let prevX = 0;
  let prevY = 0;
  let hasPen = false;
  let penX = 0;
  let penY = 0;
  let hasVisibleSegment = false;
  const wrapJumpThreshold = cssWidth * 0.6;

  function appendProjectedPoint(
    ptX: number,
    ptY: number,
    forceEmit: boolean
  ): void {
    if (!hasPrev) {
      prevX = ptX;
      prevY = ptY;
      hasPrev = true;
      hasPen = false;
      return;
    }

    if (Math.abs(ptX - prevX) > wrapJumpThreshold) {
      prevX = ptX;
      prevY = ptY;
      hasPen = false;
      return;
    }

    const intersectsViewport =
      Math.max(prevX, ptX) >= minX &&
      Math.min(prevX, ptX) <= maxX &&
      Math.max(prevY, ptY) >= minY &&
      Math.min(prevY, ptY) <= maxY;

    if (intersectsViewport) {
      if (!hasPen) {
        path.moveTo(prevX, prevY);
        path.lineTo(ptX, ptY);
        hasPen = true;
        penX = ptX;
        penY = ptY;
        hasVisibleSegment = true;
      } else if (
        forceEmit ||
        Math.abs(ptX - penX) + Math.abs(ptY - penY) >= 0.75
      ) {
        path.lineTo(ptX, ptY);
        penX = ptX;
        penY = ptY;
        hasVisibleSegment = true;
      }
    } else {
      hasPen = false;
    }

    prevX = ptX;
    prevY = ptY;
  }

  for (let i = 0; i <= maxIdx; i++) {
    const c = coords[i];
    if (isLocationOccluded(map, c[0], c[1])) {
      hasPrev = false;
      hasPen = false;
      continue;
    }
    const pt = map.project(scratchLngLat);
    if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
      hasPrev = false;
      hasPen = false;
      continue;
    }

    const isLastCoord = i === maxIdx && !tipPoint;
    appendProjectedPoint(pt.x, pt.y, isLastCoord);
  }

  if (tipPoint && !isLocationOccluded(map, tipPoint[0], tipPoint[1])) {
    const pt = map.project(scratchLngLat);
    if (Number.isFinite(pt.x) && Number.isFinite(pt.y)) {
      appendProjectedPoint(pt.x, pt.y, true);
    }
  }

  const theme = getEffectiveMapTheme();
  const casingColor = getRouteCasingColor(theme);

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  if (hasVisibleSegment) {
    // 1. Glow strokes (zero-blur translucent passes instead of shadowBlur)
    ctx.strokeStyle = style.color;
    ctx.globalAlpha = 0.14;
    ctx.lineWidth = glowWidth * 1.45;
    ctx.stroke(path);

    ctx.globalAlpha = 0.24;
    ctx.lineWidth = glowWidth;
    ctx.stroke(path);

    // 2. Casing stroke
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = casingColor;
    ctx.lineWidth = casingWidth;
    ctx.stroke(path);

    // 3. Core line stroke
    ctx.globalAlpha = 1;
    ctx.strokeStyle = style.color;
    ctx.lineWidth = lineWidth;
    if (style.mode === 'flight') {
      ctx.lineCap = 'butt';
      ctx.setLineDash([lineWidth * 2.2, lineWidth * 1.6]);
    }
    ctx.stroke(path);
  }

  // 4. Pulsing lead dot during animation
  if (
    leadPulse &&
    !isLocationOccluded(map, leadPulse.coord[0], leadPulse.coord[1])
  ) {
    const pt = map.project(scratchLngLat);
    if (Number.isFinite(pt.x) && Number.isFinite(pt.y)) {
      ctx.setLineDash([]);
      ctx.fillStyle = style.color;
      ctx.globalAlpha = leadPulse.haloOpacity;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, leadPulse.haloRadius, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 5.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    }
  }

  ctx.restore();
}

export function initRouteDrawCanvas(
  map: maplibregl.Map,
  mapEl: HTMLElement
): void {
  destroyRouteOverlay(map);

  const canvasContainer = mapEl.querySelector('.maplibregl-canvas-container');
  if (!canvasContainer) return;

  const canvas = document.createElement('canvas');
  canvas.className = 'trip-route-draw-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  canvasContainer.appendChild(canvas);

  drawCanvas = canvas;
  drawCtx = canvas.getContext('2d');
  updateCanvasBackingSize(mapEl);

  canvasResizeObserver = new ResizeObserver(() => {
    updateCanvasBackingSize(mapEl);
    if (activeDrawFrame) {
      renderActiveDrawFrame(map);
    }
  });
  canvasResizeObserver.observe(mapEl);

  renderListener = () => {
    if (activeDrawFrame) {
      renderActiveDrawFrame(map);
    }
  };
  map.on('render', renderListener);
}

export function syncRouteSources(map: maplibregl.Map | null): void {
  if (!map) return;
  const routeSource = map.getSource(ROUTE_SOURCE_ID) as
    maplibregl.GeoJSONSource | undefined;
  if (routeSource) {
    routeSource.setData(currentRouteGeoJSON);
  }
  setWebGLRouteOpacity(map, currentRouteOpacity);
}

export function redrawRouteOverlay(map: maplibregl.Map | null): void {
  if (map && activeDrawFrame) {
    renderActiveDrawFrame(map);
  }
}

export function resetRouteOverlayState(): void {
  currentRouteGeoJSON = EMPTY_FEATURE_COLLECTION;
  currentRouteOpacity = 1;
  lastStagedKey = null;
  activeDrawFrame = null;
  clearDrawCanvas();
}

export function destroyRouteOverlay(map: maplibregl.Map | null): void {
  cancelPendingHandoff(map);
  if (map && renderListener) {
    map.off('render', renderListener);
  }
  renderListener = null;

  if (canvasResizeObserver) {
    canvasResizeObserver.disconnect();
    canvasResizeObserver = null;
  }

  if (drawCanvas) {
    drawCanvas.remove();
    drawCanvas = null;
  }
  drawCtx = null;
  cssWidth = 0;
  cssHeight = 0;
  dpr = 1;
  resetRouteOverlayState();
}

function stageWebGLRoute(
  map: maplibregl.Map | null,
  coords: [number, number][] | null,
  sliceLength: number,
  style: RouteStyleState,
  visible: boolean
): void {
  setWebGLRouteOpacity(map, visible ? 1 : 0);

  if (!coords || sliceLength < 2) {
    if (currentRouteGeoJSON.features.length > 0) {
      currentRouteGeoJSON = EMPTY_FEATURE_COLLECTION;
      lastStagedKey = null;
      const routeSource = map?.getSource(ROUTE_SOURCE_ID) as
        maplibregl.GeoJSONSource | undefined;
      routeSource?.setData(currentRouteGeoJSON);
    }
    return;
  }

  const clampedLen = Math.min(sliceLength, coords.length);
  const alreadyStaged =
    lastStagedKey !== null &&
    lastStagedKey.coordsRef === coords &&
    lastStagedKey.sliceLength === clampedLen &&
    lastStagedKey.color === style.color &&
    lastStagedKey.mode === style.mode;

  if (alreadyStaged) {
    return;
  }

  const stagedCoords =
    clampedLen === coords.length ? coords : coords.slice(0, clampedLen);
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
          coordinates: stagedCoords
        }
      }
    ]
  };
  lastStagedKey = {
    coordsRef: coords,
    sliceLength: clampedLen,
    color: style.color,
    mode: style.mode
  };

  const routeSource = map?.getSource(ROUTE_SOURCE_ID) as
    maplibregl.GeoJSONSource | undefined;
  routeSource?.setData(currentRouteGeoJSON);
}

function handoffToWebGL(
  map: maplibregl.Map | null,
  coords: [number, number][],
  sliceLength: number,
  style: RouteStyleState
): void {
  cancelPendingHandoff(map);

  if (!map || sliceLength < 2) {
    clearRouteOverlay(map);
    return;
  }

  stageWebGLRoute(map, coords, sliceLength, style, false);

  const finishHandoff = () => {
    cancelPendingHandoff(map);
    activeDrawFrame = null;
    clearDrawCanvas();
    setWebGLRouteOpacity(map, 1);
    map.triggerRepaint();
  };

  if (map.isSourceLoaded(ROUTE_SOURCE_ID)) {
    finishHandoff();
    return;
  }

  // Keep static slice painted on 2D canvas until WebGL GeoJSON worker finishes
  activeDrawFrame = {
    coords,
    endIdx: Math.min(sliceLength, coords.length) - 1,
    tipPoint: null,
    style,
    leadPulse: null
  };
  renderActiveDrawFrame(map);

  const token = handoffToken;
  const onSourceData = (e: maplibregl.MapSourceDataEvent) => {
    if (token !== handoffToken) return;
    if (e.sourceId === ROUTE_SOURCE_ID && map.isSourceLoaded(ROUTE_SOURCE_ID)) {
      finishHandoff();
    }
  };
  pendingSourceDataListener = onSourceData;
  map.on('sourcedata', onSourceData);

  pendingHandoffTimer = window.setTimeout(() => {
    if (token === handoffToken) {
      finishHandoff();
    }
  }, 350);
}

export function clearRouteOverlay(map: maplibregl.Map | null): void {
  cancelPendingHandoff(map);
  activeDrawFrame = null;
  clearDrawCanvas();
  stageWebGLRoute(map, null, 0, { color: '', glow: '', mode: 'drive' }, true);
}

export function cancelRouteDrawCanvas(map: maplibregl.Map | null): void {
  cancelPendingHandoff(map);
  activeDrawFrame = null;
  clearDrawCanvas();
}

export function getCurrentDrawnCoordinates(): [number, number][] | null {
  if (!activeDrawFrame) return null;
  const { coords, endIdx, tipPoint } = activeDrawFrame;
  const slice = coords.slice(0, Math.min(endIdx + 1, coords.length));
  if (tipPoint) {
    slice.push(tipPoint);
  }
  return slice;
}

export function updateRouteOverlay(
  map: maplibregl.Map | null,
  activeCoordinates: [number, number][] | null,
  style: RouteStyleState
): void {
  if (!activeCoordinates || activeCoordinates.length < 2) {
    clearRouteOverlay(map);
    return;
  }
  handoffToWebGL(map, activeCoordinates, activeCoordinates.length, style);
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
    updateRouteOverlay(map, coords, style);
    return null;
  }

  cancelPendingHandoff(map);
  // Pre-stage full settled route once at t=0 while keeping WebGL invisible
  stageWebGLRoute(map, coords, len, style, false);
  callbacks.onUpdateCoords([coords[0], coords[0]]);

  const totalDist = tripCumulativeDistances[len - 1] || 0;
  const duration = Math.min(2600, Math.max(1800, 1600 + distanceMiles * 0.6));
  const startTime = performance.now();
  let animationId: number | null = null;

  function step(now: number) {
    if (callbacks.getCurrentStopIndex() !== -1) {
      return;
    }

    const elapsed = now - startTime;
    const progress = Math.min(1, elapsed / duration);
    const ease = 0.5 - 0.5 * Math.cos(Math.PI * progress);
    const targetDist = totalDist * ease;

    if (progress >= 1) {
      if (callbacks.getCurrentStopIndex() === -1) {
        callbacks.onUpdateCoords(coords);
        handoffToWebGL(map, coords, len, style);
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

    activeDrawFrame = {
      coords,
      endIdx: segIdx,
      tipPoint,
      style,
      leadPulse: getPulseLeadPoint(tipPoint, elapsed)
    };
    renderActiveDrawFrame(map);

    animationId = requestAnimationFrame(step);
  }

  activeDrawFrame = {
    coords,
    endIdx: 0,
    tipPoint: coords[0],
    style,
    leadPulse: getPulseLeadPoint(coords[0], 0)
  };
  renderActiveDrawFrame(map);
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
    handoffToWebGL(map, fullTripCoordinates, endVertex + 1, style);
    if (destStop) {
      map.jumpTo({ center: [destStop.lng, destStop.lat] });
      callbacks.activateStopMarker(destStop);
    }
    callbacks.onComplete();
    return null;
  }

  cancelPendingHandoff(map);
  // Pre-stage settled leg slice once at t=0 while keeping WebGL invisible
  stageWebGLRoute(map, fullTripCoordinates, endVertex + 1, style, false);

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
      handoffToWebGL(map, fullTripCoordinates, endVertex + 1, style);

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

    activeDrawFrame = {
      coords: fullTripCoordinates,
      endIdx: segIdx,
      tipPoint,
      style,
      leadPulse: getPulseLeadPoint(tipPoint, elapsed)
    };

    map.jumpTo({
      center: [targetCamLng, targetCamLat],
      zoom: currentZoom
    });
    map.triggerRepaint();

    animationId = requestAnimationFrame(step);
  }

  animationId = requestAnimationFrame(step);
  return animationId;
}
