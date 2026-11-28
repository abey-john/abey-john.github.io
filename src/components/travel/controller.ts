import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { getTripTheme } from '../../utils/travelColors';
import type {
  PlaceData,
  TripData,
  TripStop,
  MarkerRecord,
  FilterCategory,
  RouteStyleState
} from './types';
import {
  buildTravelMapStyle,
  getEffectiveMapTheme,
  observeMapThemeChanges
} from './map-style';
import {
  createGlobeAutoRotation,
  type GlobeRotationController
} from './globe-rotation';
import { createGlobeDrag, type GlobeDragController } from './globe-drag';
import {
  getRouteGeoJSON,
  getCurrentRouteOpacity,
  initRouteDrawCanvas,
  syncRouteSources,
  redrawRouteOverlay,
  clearRouteOverlay,
  cancelRouteDrawCanvas,
  getCurrentDrawnCoordinates,
  destroyRouteOverlay,
  updateRouteOverlay,
  calculateStopIndices,
  calculateCumulativeDistances,
  startRouteDrawAnimation,
  animateRouteSegment
} from './route-overlay';
import { createMarkers } from './markers';
import { setupTripsDropdown, updateTripsDropdownUI } from './dropdown';
import { initImageModal, openImageModal } from './image-modal';
import { setupPlacesDirectory, updateDirectoryList } from './directory';
import {
  updateStepperUI,
  activateStopMarker,
  navigateToCurrentStop,
  fitCurrentTripBounds,
  setupKeyboardNav
} from './stepper';

maplibregl.setWorkerUrl(workerUrl);

const INITIAL_GLOBE_CENTER: [number, number] = [-97.5, 36.0];
// MapLibre's globe mode defines minZoom at the equator (lat = 0) and shifts it by
// log2(cos(lat)) at other latitudes, so subtracting getLatZoomOffset(INITIAL_GLOBE_CENTER[1])
// locks the minimum visual globe diameter to match getMinGlobeZoomAtInitialLat() everywhere on the sphere.
const MAX_VALID_LATITUDE = 85.051129;
const VENUE_MIN_ZOOM = 9;

function getLatZoomOffset(lat: number): number {
  const clamped = Math.min(Math.abs(lat), MAX_VALID_LATITUDE);
  return Math.log(Math.cos((clamped * Math.PI) / 180)) / Math.LN2;
}

function getResponsiveGlobeZoom(
  mobileRatio: number,
  desktopRatio: number,
  minZoom: number,
  maxZoom: number,
  ssrFallback: number
): number {
  if (typeof window === 'undefined') return ssrFallback;
  const mapEl = document.getElementById('travel-map');
  const w = mapEl?.clientWidth || window.innerWidth;
  const h = mapEl?.clientHeight || Math.max(520, window.innerHeight - 65);
  const targetDiameter =
    Math.min(w, h) * (w < 640 ? mobileRatio : desktopRatio);
  return Math.max(minZoom, Math.min(maxZoom, Math.log2(targetDiameter / 139)));
}

function getInitialGlobeZoom(): number {
  return getResponsiveGlobeZoom(0.86, 0.78, 1.2, 2.65, 2.15);
}

function getMinGlobeZoomAtInitialLat(): number {
  return getResponsiveGlobeZoom(0.68, 0.65, 0.8, 2.38, 1.85);
}

function getMinGlobeZoom(): number {
  return (
    getMinGlobeZoomAtInitialLat() - getLatZoomOffset(INITIAL_GLOBE_CENTER[1])
  );
}

function getConstrainedMinGlobeZoom(map: maplibregl.Map): number {
  return map.getMinZoom() + getLatZoomOffset(map.getCenter().lat);
}

let mapInstance: maplibregl.Map | null = null;
let markerRecords: MarkerRecord[] = [];
let rawTrips: TripData[] = [];
let activeTripId: string | null = null;
let activeFilter: FilterCategory = 'all';

let fullTripCoordinates: [number, number][] | null = null;
let activeTripCoordinates: [number, number][] | null = null;
let activeRouteStyle: RouteStyleState = {
  color: '#f59e0b',
  glow: 'rgba(245, 158, 11, 0.45)',
  mode: 'drive'
};
let routeAnimationId: number | null = null;
let currentStopIndex = -1;
let currentTripStops: TripStop[] = [];
let currentTripStopIndices: number[] = [];
let tripCumulativeDistances: number[] = [];

let globeRotation: GlobeRotationController | null = null;
let globeDrag: GlobeDragController | null = null;
let cleanupThemeObserver: (() => void) | null = null;
let cleanupDropdownListeners: (() => void) | null = null;
let cleanupDirectoryListeners: (() => void) | null = null;
let cleanupKeyNavListener: (() => void) | null = null;
let cleanupImageModalListener: (() => void) | null = null;
let activeFlightId = 0;
let activeRecenterId = 0;
let lastVenueZoomVisible: boolean | null = null;
let mapReadyTimeoutId: number | null = null;

function cancelCurrentAnimation() {
  if (routeAnimationId) {
    cancelAnimationFrame(routeAnimationId);
    routeAnimationId = null;
  }
  cancelRouteDrawCanvas(mapInstance);
}

function getOverviewResetDuration(map: maplibregl.Map): number {
  const currentCenter = map.getCenter();
  const [defaultCenterLng, defaultCenterLat] = INITIAL_GLOBE_CENTER;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(defaultCenterLat - currentCenter.lat);
  const dLng = toRad(defaultCenterLng - currentCenter.lng);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(currentCenter.lat)) *
      Math.cos(toRad(defaultCenterLat)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const approxMiles = 3959 * c;

  // Intercontinental reset (e.g. from Switzerland) takes 2200ms; domestic stays snappy 900ms
  return approxMiles > 2500 ? 2200 : 900;
}

export function setActiveTrip(tripId: string | null, fitBounds = false): void {
  if (!mapInstance) return;

  if (activeTripId === tripId && !fitBounds) {
    tripId = null;
  }
  activeTripId = tripId;

  const currentTrip = tripId
    ? rawTrips.find((t) => t.id === tripId)
    : undefined;
  updateTripsDropdownUI(activeTripId, currentTrip, rawTrips.length);

  const containerEl = mapInstance
    .getContainer()
    .closest('.travel-map-container');
  containerEl?.classList.toggle(
    'has-active-trip',
    Boolean(tripId && currentTrip)
  );

  if (!tripId || !currentTrip) {
    cancelCurrentAnimation();
    clearRouteOverlay(mapInstance);
    activeTripCoordinates = null;
    fullTripCoordinates = null;
    activeRouteStyle = {
      color: '#f59e0b',
      glow: 'rgba(245, 158, 11, 0.45)',
      mode: 'drive'
    };
    currentTripStops = [];
    currentStopIndex = -1;
    currentTripStopIndices = [];
    tripCumulativeDistances = [];

    const stepperEl = document.getElementById('itinerary-stepper');
    if (stepperEl) {
      stepperEl.style.display = 'none';
      stepperEl.classList.remove('has-summary');
    }

    markerRecords.forEach(({ element, popup }) => {
      element.classList.remove('in-active-trip', 'trip-dimmed');
      const badge = element.querySelector<HTMLElement>('.trip-stop-badge');
      if (badge) {
        badge.innerHTML = '';
        badge.removeAttribute('title');
        badge.style.display = 'none';
      }
      if (popup && popup.isOpen()) {
        popup.remove();
      }
    });

    syncMarkerVisibility();

    if (fitBounds) {
      globeDrag?.stop();
      mapInstance.flyTo({
        center: INITIAL_GLOBE_CENTER,
        zoom: getInitialGlobeZoom(),
        bearing: 0,
        pitch: 0,
        duration: getOverviewResetDuration(mapInstance),
        essential: true
      });
    }

    return;
  }

  ++activeRecenterId;
  globeRotation?.stop();
  globeDrag?.stop();
  cancelCurrentAnimation();

  // Close any open popups so the whole route can be viewed without obstruction
  markerRecords.forEach(({ popup }) => {
    if (popup && popup.isOpen()) {
      popup.remove();
    }
  });

  const theme = getTripTheme(currentTrip.color);

  // Set route coordinates on WebGL source & trigger draw animation
  activeRouteStyle = {
    color: theme.line,
    glow: theme.glow,
    mode: currentTrip.mode || 'drive'
  };
  currentTripStops = currentTrip.stops || [];
  currentStopIndex = -1;
  currentTripStopIndices = calculateStopIndices(
    currentTrip.geometry.coordinates,
    currentTripStops
  );
  tripCumulativeDistances = calculateCumulativeDistances(
    currentTrip.geometry.coordinates
  );
  fullTripCoordinates = currentTrip.geometry.coordinates;

  routeAnimationId = startRouteDrawAnimation(
    mapInstance,
    currentTrip.geometry.coordinates,
    currentTrip.distanceMiles || 500,
    activeRouteStyle,
    tripCumulativeDistances,
    {
      getCurrentStopIndex: () => currentStopIndex,
      onUpdateCoords: (coords) => {
        activeTripCoordinates = coords;
      },
      onComplete: () => {
        routeAnimationId = null;
      }
    }
  );

  // Show and configure itinerary stepper
  const stepperEl = document.getElementById('itinerary-stepper');
  if (stepperEl && currentTripStops.length > 0) {
    stepperEl.style.display = 'inline-flex';
    stepperEl.style.setProperty('--active-trip-color', theme.line);
    updateStepperUI(currentStopIndex, currentTripStops, currentTrip);
  }

  // Highlight markers in this trip and dim others
  markerRecords.forEach(({ element, place }) => {
    const tripMatch = place.trips?.find((t) => t.tripId === tripId);
    const badge = element.querySelector<HTMLElement>('.trip-stop-badge');

    if (tripMatch) {
      element.classList.add('in-active-trip');
      element.classList.remove('trip-dimmed');
      element.style.setProperty('--active-trip-color', theme.line);
      element.style.setProperty('--active-trip-glow', theme.glow);

      if (badge) {
        const isLoopStartEnd =
          tripMatch.stopIndices.includes(1) &&
          tripMatch.stopIndices.includes(tripMatch.totalStops);

        if (isLoopStartEnd) {
          badge.innerHTML = `<svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor" aria-hidden="true"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`;
          badge.title = 'Start & Finish';
        } else {
          badge.textContent = tripMatch.stopIndices.join(',');
          badge.title =
            tripMatch.stopIndices.length > 1
              ? `Stops ${tripMatch.stopIndices.join(', ')}`
              : `Stop ${tripMatch.stopIndices[0]}`;
        }
        badge.style.display = 'flex';
        badge.style.backgroundColor = theme.line;
      }
    } else {
      element.classList.remove('in-active-trip');
      element.classList.add('trip-dimmed');
      if (badge) {
        badge.innerHTML = '';
        badge.removeAttribute('title');
        badge.style.display = 'none';
      }
    }
  });

  syncMarkerVisibility();

  // Fit camera to the trip route if requested
  if (fitBounds && currentTrip.geometry.coordinates.length > 0) {
    fitCurrentTripBounds(mapInstance, fullTripCoordinates, markerRecords);
  }
}

function syncMarkerVisibility(): void {
  const currentZoom = mapInstance ? mapInstance.getZoom() : 0;
  lastVenueZoomVisible = currentZoom >= VENUE_MIN_ZOOM;

  markerRecords.forEach(({ element, popup, type }) => {
    let isVisible = false;
    if (type === 'venue') {
      const categoryAllowsVenue =
        activeFilter === 'all' || activeFilter === 'city';
      const zoomAllowsVenue =
        lastVenueZoomVisible || element.classList.contains('in-active-trip');
      isVisible = categoryAllowsVenue && zoomAllowsVenue;
    } else {
      isVisible = activeFilter === 'all' || type === activeFilter;
    }

    element.style.display = isVisible ? 'flex' : 'none';
    if (!isVisible && popup.isOpen()) {
      popup.remove();
    }
  });
}

export function applyCategoryFilter(category: FilterCategory): void {
  activeFilter = category;

  // 1. Toggle MapLibre markers
  syncMarkerVisibility();

  // 2. Update pill UI button states
  const pills = document.querySelectorAll<HTMLButtonElement>(
    '.filter-pill[data-category]'
  );
  pills.forEach((pill) => {
    const isSelected = pill.dataset.category === category;
    pill.classList.toggle('active', isSelected);
    pill.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
  });

  // 3. Filter grouped text directory and update counts
  updateDirectoryList(activeFilter);
}

export function recenterMap(): void {
  if (!mapInstance) return;

  const currentRecenter = ++activeRecenterId;
  ++activeFlightId;
  globeRotation?.stop();
  globeDrag?.stop();

  setActiveTrip(null, false);
  applyCategoryFilter('all');

  markerRecords.forEach(({ popup }) => {
    if (popup.isOpen()) {
      popup.remove();
    }
  });

  mapInstance.flyTo({
    center: INITIAL_GLOBE_CENTER,
    zoom: getInitialGlobeZoom(),
    bearing: 0,
    pitch: 0,
    duration: getOverviewResetDuration(mapInstance),
    essential: true
  });

  mapInstance.once('moveend', () => {
    if (currentRecenter === activeRecenterId && mapInstance && !activeTripId) {
      globeRotation?.start();
    }
  });
}

export function flyToPlace(
  id: string,
  lat: number,
  lng: number,
  type: string
): void {
  if (!mapInstance) return;
  ++activeRecenterId;
  globeRotation?.stop();
  globeDrag?.stop();
  const currentFlight = ++activeFlightId;

  markerRecords.forEach(({ popup }) => {
    if (popup.isOpen()) {
      popup.remove();
    }
  });

  if (activeFilter !== 'all' && activeFilter !== type) {
    applyCategoryFilter('all');
  }

  const mapWrapper = document.getElementById('map-wrapper');
  if (mapWrapper) {
    const rect = mapWrapper.getBoundingClientRect();
    const headerOffset = 65;
    const targetScroll = window.scrollY + rect.top - headerOffset;
    window.scrollTo({
      top: Math.max(0, targetScroll),
      behavior: 'smooth'
    });
  }

  mapInstance.flyTo({
    center: [lng, lat],
    zoom: 8.5,
    speed: 1.35,
    curve: 1.42,
    essential: true
  });

  const record = markerRecords.find(
    (r) =>
      r.id === id ||
      (Math.abs(r.lat - lat) < 0.0001 && Math.abs(r.lng - lng) < 0.0001)
  );

  if (record) {
    let done = false;
    const onFlightDone = () => {
      if (done) return;
      done = true;
      if (currentFlight !== activeFlightId || !mapInstance) return;
      markerRecords.forEach(({ popup }) => {
        if (popup !== record.popup && popup.isOpen()) {
          popup.remove();
        }
      });
      if (!record.popup.isOpen()) {
        record.marker.togglePopup();
      }
      const pinEl = record.element.querySelector('.pin-marker');
      if (pinEl) {
        pinEl.classList.add('pin-pulse');
        setTimeout(() => {
          pinEl.classList.remove('pin-pulse');
        }, 2400);
      }
    };

    mapInstance.once('moveend', onFlightDone);
    setTimeout(onFlightDone, 850);
  }
}

export function initTravelMap(): void {
  const mapEl = document.getElementById('travel-map');
  if (!mapEl || !mapEl.dataset.places) return;

  cleanupTravelMap();
  mapEl.classList.remove('is-ready');
  const loaderEl = document.getElementById('globe-loader');
  loaderEl?.classList.remove('is-hidden');
  const startToken = activeRecenterId;

  const rawPlaces: PlaceData[] = JSON.parse(mapEl.dataset.places);
  rawTrips = JSON.parse(
    document.getElementById('trips-json')?.textContent || '[]'
  );

  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const map = new maplibregl.Map({
    container: mapEl,
    style: buildTravelMapStyle(getEffectiveMapTheme(), getRouteGeoJSON()),
    center: INITIAL_GLOBE_CENTER,
    zoom: getInitialGlobeZoom(),
    minZoom: getMinGlobeZoomAtInitialLat(),
    maxZoom: 19,
    pixelRatio: Math.min(dpr, 2),
    canvasContextAttributes: { antialias: dpr < 2 },
    fadeDuration: 100,
    maxTileCacheSize: 250,
    maxTileCacheZoomLevels: 8,
    cancelPendingTileRequestsWhileZooming: false,
    refreshExpiredTiles: false,
    attributionControl: false,
    dragRotate: false,
    touchPitch: false,
    pitchWithRotate: false,
    renderWorldCopies: true,
    crossSourceCollisions: false,
    collectResourceTiming: false
  });
  mapInstance = map;

  const navControl = new maplibregl.NavigationControl({ showCompass: false });
  map.addControl(navControl, 'top-left');

  const zoomOutBtn = mapEl.querySelector<HTMLButtonElement>(
    '.maplibregl-ctrl-zoom-out'
  );
  const syncZoomOutButton = () => {
    if (!zoomOutBtn || mapInstance !== map) return;
    const effectiveMin =
      map.getProjection()?.type === 'globe'
        ? getConstrainedMinGlobeZoom(map)
        : map.getMinZoom();
    const isAtMin = map.getZoom() <= effectiveMin + 1e-3;
    zoomOutBtn.disabled = isAtMin;
    zoomOutBtn.setAttribute('aria-disabled', String(isAtMin));
  };
  map.on('move', syncZoomOutButton);

  const ctrlGroup = mapEl.querySelector(
    '.maplibregl-ctrl-top-left .maplibregl-ctrl-group'
  );
  if (ctrlGroup) {
    const recenterBtn = document.createElement('button');
    recenterBtn.type = 'button';
    recenterBtn.className = 'maplibregl-ctrl-recenter';
    recenterBtn.title = 'Recenter map';
    recenterBtn.setAttribute('aria-label', 'Recenter map to default overview');
    recenterBtn.innerHTML = `
      <span class="recenter-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="8"></circle>
          <line x1="12" y1="2" x2="12" y2="6"></line>
          <line x1="12" y1="18" x2="12" y2="22"></line>
          <line x1="2" y1="12" x2="6" y2="12"></line>
          <line x1="18" y1="12" x2="22" y2="12"></line>
          <circle cx="12" cy="12" r="2" fill="currentColor"></circle>
        </svg>
      </span>
    `;
    recenterBtn.onclick = recenterMap;
    ctrlGroup.appendChild(recenterBtn);
  }

  // Keep scroll zoom smoothly enabled at all times
  map.scrollZoom.enable();
  map.scrollZoom.setWheelZoomRate(1 / 450);

  initRouteDrawCanvas(map, mapEl);

  cleanupThemeObserver = observeMapThemeChanges((nextTheme) => {
    if (!mapInstance) return;
    mapInstance.setStyle(buildTravelMapStyle(nextTheme, getRouteGeoJSON()), {
      diff: true
    });
    mapInstance.setGlobalStateProperty(
      'routeOpacity',
      getCurrentRouteOpacity()
    );
    syncRouteSources(mapInstance);
    redrawRouteOverlay(mapInstance);
  });

  globeRotation = createGlobeAutoRotation(map, mapEl);
  globeDrag = createGlobeDrag(map, mapEl, {
    onDragStart: () => {
      ++activeRecenterId;
      globeRotation?.stop();
      if (routeAnimationId) {
        cancelAnimationFrame(routeAnimationId);
        routeAnimationId = null;
        if (
          currentStopIndex > 0 &&
          currentTripStopIndices[currentStopIndex] !== undefined &&
          fullTripCoordinates
        ) {
          activeTripCoordinates = fullTripCoordinates.slice(
            0,
            currentTripStopIndices[currentStopIndex] + 1
          );
          updateRouteOverlay(map, activeTripCoordinates, activeRouteStyle);
        } else if (currentStopIndex === 0) {
          activeTripCoordinates = null;
          clearRouteOverlay(map);
        } else {
          activeTripCoordinates =
            getCurrentDrawnCoordinates() || activeTripCoordinates;
          updateRouteOverlay(map, activeTripCoordinates, activeRouteStyle);
        }
      }
    }
  });

  map.on('wheel', () => {
    ++activeRecenterId;
    globeRotation?.stop();
    globeDrag?.stop();
  });

  map.on('zoomstart', (e) => {
    if ((e as { globeDrag?: boolean }).globeDrag) return;
    if (!globeDrag?.isDragging()) {
      globeDrag?.stop();
    }
  });

  let mapReadyDone = false;
  const markMapReady = () => {
    if (mapReadyDone) return;
    mapReadyDone = true;
    if (mapReadyTimeoutId !== null) {
      window.clearTimeout(mapReadyTimeoutId);
      mapReadyTimeoutId = null;
    }
    loaderEl?.classList.add('is-hidden');
    requestAnimationFrame(() => {
      if (mapInstance === map) {
        mapEl.classList.add('is-ready');
        if (!activeTripId && activeRecenterId === startToken) {
          globeRotation?.start();
        }
      }
    });
  };
  mapReadyTimeoutId = window.setTimeout(markMapReady, 2500);

  const syncMinGlobeZoom = () => {
    if (mapInstance !== map) return;
    if (map.getProjection()?.type !== 'globe') return;
    const nextMinZoom = getMinGlobeZoom();
    if (Math.abs(map.getMinZoom() - nextMinZoom) > 1e-4) {
      map.setMinZoom(nextMinZoom);
    }
    syncZoomOutButton();
  };

  map.on('style.load', syncMinGlobeZoom);
  map.on('resize', syncMinGlobeZoom);

  map.on('load', () => {
    syncMarkerVisibility();
    syncRouteSources(map);
    syncZoomOutButton();
  });

  map.once('idle', markMapReady);

  map.on('zoom', () => {
    const isVenueZoomVisible = map.getZoom() >= VENUE_MIN_ZOOM;
    if (isVenueZoomVisible !== lastVenueZoomVisible) {
      syncMarkerVisibility();
    }
  });

  // Create markers with callbacks
  markerRecords = createMarkers(map, mapEl, rawPlaces, {
    onSelectTrip: (tripId) => {
      setActiveTrip(tripId, true);
    },
    onMarkerClick: (place) => {
      ++activeRecenterId;
      globeRotation?.stop();
      globeDrag?.stop();
      if (activeTripId && currentTripStops.length > 0 && fullTripCoordinates) {
        const stopIdx = currentTripStops.findIndex(
          (s) =>
            (s.placeId && s.placeId === place.id) ||
            (Math.abs(s.lat - place.lat) < 0.001 &&
              Math.abs(s.lng - place.lng) < 0.001) ||
            s.name.toLowerCase().trim() === place.name.toLowerCase().trim()
        );
        if (stopIdx !== -1) {
          currentStopIndex = stopIdx;
          const currentTrip = rawTrips.find((t) => t.id === activeTripId);
          updateStepperUI(currentStopIndex, currentTripStops, currentTrip);
          cancelCurrentAnimation();
          if (stopIdx === 0) {
            activeTripCoordinates = [
              fullTripCoordinates[0],
              fullTripCoordinates[0]
            ];
          } else if (currentTripStopIndices[stopIdx] !== undefined) {
            activeTripCoordinates = fullTripCoordinates.slice(
              0,
              currentTripStopIndices[stopIdx] + 1
            );
          }
          updateRouteOverlay(map, activeTripCoordinates, activeRouteStyle);
        }
      }
    },
    onOpenImageModal: (modalData) => {
      openImageModal(modalData);
    }
  });

  // Attach listeners to category filter pills
  const categoryPills = document.querySelectorAll<HTMLButtonElement>(
    '.filter-pill[data-category]'
  );
  categoryPills.forEach((pill) => {
    pill.onclick = () => {
      const cat = (pill.dataset.category as FilterCategory) || 'all';
      if (cat !== 'all' && activeFilter === cat) {
        applyCategoryFilter('all');
      } else {
        applyCategoryFilter(cat);
      }
    };
  });

  // Attach listeners to itinerary stepper buttons
  const stepperPrev = document.getElementById(
    'stepper-prev'
  ) as HTMLButtonElement | null;
  const stepperNext = document.getElementById(
    'stepper-next'
  ) as HTMLButtonElement | null;
  const stepperContent = document.getElementById('stepper-content');
  const stepperFit = document.getElementById(
    'stepper-fit'
  ) as HTMLButtonElement | null;

  if (stepperPrev) {
    stepperPrev.onclick = () => {
      globeDrag?.stop();
      if (currentStopIndex > 0) {
        const toIdx = currentStopIndex - 1;
        currentStopIndex = toIdx;
        cancelCurrentAnimation();
        if (toIdx === 0) {
          activeTripCoordinates = null;
        } else if (
          fullTripCoordinates &&
          currentTripStopIndices[toIdx] !== undefined
        ) {
          activeTripCoordinates = fullTripCoordinates.slice(
            0,
            currentTripStopIndices[toIdx] + 1
          );
        }
        updateRouteOverlay(map, activeTripCoordinates, activeRouteStyle);
        const stop = currentTripStops[currentStopIndex];
        const currentTrip = rawTrips.find((t) => t.id === activeTripId);
        updateStepperUI(currentStopIndex, currentTripStops, currentTrip);
        navigateToCurrentStop(map, stop, markerRecords);
      } else if (currentStopIndex === 0) {
        cancelCurrentAnimation();
        currentStopIndex = -1;
        activeTripCoordinates = fullTripCoordinates;
        updateRouteOverlay(map, activeTripCoordinates, activeRouteStyle);
        const currentTrip = rawTrips.find((t) => t.id === activeTripId);
        updateStepperUI(currentStopIndex, currentTripStops, currentTrip);
        fitCurrentTripBounds(map, fullTripCoordinates, markerRecords);
      }
    };
  }

  if (stepperNext) {
    stepperNext.onclick = () => {
      globeDrag?.stop();
      if (currentStopIndex < currentTripStops.length - 1) {
        const fromIdx = currentStopIndex;
        const toIdx = currentStopIndex + 1;
        currentStopIndex = toIdx;

        if (fromIdx < 0) {
          cancelCurrentAnimation();
          activeTripCoordinates = null;
          updateRouteOverlay(map, activeTripCoordinates, activeRouteStyle);
          const stop = currentTripStops[currentStopIndex];
          const currentTrip = rawTrips.find((t) => t.id === activeTripId);
          updateStepperUI(currentStopIndex, currentTripStops, currentTrip);
          navigateToCurrentStop(map, stop, markerRecords);
        } else if (fullTripCoordinates) {
          const currentTrip = rawTrips.find((t) => t.id === activeTripId);
          updateStepperUI(currentStopIndex, currentTripStops, currentTrip);
          cancelCurrentAnimation();
          routeAnimationId = animateRouteSegment(
            map,
            fromIdx,
            toIdx,
            fullTripCoordinates,
            currentTripStopIndices,
            tripCumulativeDistances,
            currentTripStops,
            activeRouteStyle,
            {
              onClosePopups: () => {
                markerRecords.forEach(({ popup }) => {
                  if (popup.isOpen()) popup.remove();
                });
              },
              onUpdateCoords: (coords) => {
                activeTripCoordinates = coords;
              },
              activateStopMarker: (stop) => {
                activateStopMarker(stop, markerRecords);
              },
              onComplete: () => {
                routeAnimationId = null;
              }
            }
          );
        }
      }
    };
  }

  if (stepperContent) {
    const handleContentAction = () => {
      globeDrag?.stop();
      if (currentStopIndex < 0) {
        currentStopIndex = 0;
        cancelCurrentAnimation();
        activeTripCoordinates = null;
        updateRouteOverlay(map, activeTripCoordinates, activeRouteStyle);
        const stop = currentTripStops[currentStopIndex];
        const currentTrip = rawTrips.find((t) => t.id === activeTripId);
        updateStepperUI(currentStopIndex, currentTripStops, currentTrip);
        navigateToCurrentStop(map, stop, markerRecords);
      } else {
        const stop = currentTripStops[currentStopIndex];
        navigateToCurrentStop(map, stop, markerRecords);
      }
    };
    stepperContent.onclick = handleContentAction;
    stepperContent.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleContentAction();
      }
    };
  }

  if (stepperFit) {
    stepperFit.onclick = () => {
      globeDrag?.stop();
      cancelCurrentAnimation();
      currentStopIndex = -1;
      activeTripCoordinates = fullTripCoordinates;
      updateRouteOverlay(map, activeTripCoordinates, activeRouteStyle);
      const currentTrip = rawTrips.find((t) => t.id === activeTripId);
      updateStepperUI(currentStopIndex, currentTripStops, currentTrip);
      fitCurrentTripBounds(map, fullTripCoordinates, markerRecords);
    };
  }

  // Keyboard navigation for stepper
  cleanupKeyNavListener = setupKeyboardNav({
    isTripActive: () => Boolean(activeTripId && currentTripStops.length > 0),
    onNext: () => {
      if (stepperNext && !stepperNext.disabled) {
        stepperNext.click();
      }
    },
    onPrev: () => {
      if (stepperPrev && !stepperPrev.disabled) {
        stepperPrev.click();
      }
    },
    onEscape: () => {
      const openPopup = markerRecords.find((r) => r.popup.isOpen());
      if (openPopup) {
        openPopup.popup.remove();
        openPopup.element.focus();
      } else if (currentStopIndex !== -1 && stepperFit) {
        stepperFit.click();
      }
    }
  });

  // Setup trips dropdown
  cleanupDropdownListeners = setupTripsDropdown({
    onSelectTrip: (tripId) => {
      if (!tripId || activeTripId === tripId) {
        setActiveTrip(null, true);
      } else {
        setActiveTrip(tripId, true);
      }
    },
    getActiveTripId: () => activeTripId
  });

  // Setup places directory search & card selection
  cleanupDirectoryListeners = setupPlacesDirectory({
    getActiveFilter: () => activeFilter,
    onSelectPlace: (id, lat, lng, type) => {
      flyToPlace(id, lat, lng, type);
    }
  });

  const scrollToDirBtn = document.getElementById('scroll-to-directory-btn');
  if (scrollToDirBtn) {
    scrollToDirBtn.onclick = () => {
      const dirSection = document.getElementById('places-directory-section');
      const detailsEl =
        dirSection?.querySelector<HTMLDetailsElement>('.places-details');
      if (detailsEl) {
        detailsEl.open = true;
      }
      dirSection?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  }

  // Apply active category filter state
  applyCategoryFilter(activeFilter);

  cleanupImageModalListener = initImageModal();

  requestAnimationFrame(() => {
    map.resize();
  });
}

export function cleanupTravelMap(): void {
  const scrollToDirBtn = document.getElementById('scroll-to-directory-btn');
  if (scrollToDirBtn) {
    scrollToDirBtn.onclick = null;
  }
  if (mapReadyTimeoutId !== null) {
    window.clearTimeout(mapReadyTimeoutId);
    mapReadyTimeoutId = null;
  }
  if (globeDrag) {
    globeDrag.destroy();
    globeDrag = null;
  }
  if (globeRotation) {
    globeRotation.destroy();
    globeRotation = null;
  }
  if (cleanupThemeObserver) {
    cleanupThemeObserver();
    cleanupThemeObserver = null;
  }

  if (routeAnimationId) {
    cancelAnimationFrame(routeAnimationId);
    routeAnimationId = null;
  }
  destroyRouteOverlay(mapInstance);
  lastVenueZoomVisible = null;

  if (mapInstance) {
    try {
      mapInstance.remove();
    } catch (e) {}
    mapInstance = null;
  }
  markerRecords = [];
  activeTripId = null;
  currentTripStops = [];
  currentStopIndex = -1;
  currentTripStopIndices = [];
  tripCumulativeDistances = [];
  activeTripCoordinates = null;
  fullTripCoordinates = null;
  activeRouteStyle = {
    color: '#f59e0b',
    glow: 'rgba(245, 158, 11, 0.45)',
    mode: 'drive'
  };

  if (cleanupDropdownListeners) {
    cleanupDropdownListeners();
    cleanupDropdownListeners = null;
  }
  if (cleanupDirectoryListeners) {
    cleanupDirectoryListeners();
    cleanupDirectoryListeners = null;
  }
  if (cleanupKeyNavListener) {
    cleanupKeyNavListener();
    cleanupKeyNavListener = null;
  }
  if (cleanupImageModalListener) {
    cleanupImageModalListener();
    cleanupImageModalListener = null;
  }
}
