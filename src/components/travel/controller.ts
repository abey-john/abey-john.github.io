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
  RouteSvgOverlayElements,
} from './types';
import {
  createRouteSvgOverlay,
  updateRouteSvg,
  calculateStopIndices,
  calculateCumulativeDistances,
  startRouteDrawAnimation,
  animateRouteSegment,
} from './route-overlay';
import { createMarkers } from './markers';
import { setupTripsDropdown, updateTripsDropdownUI } from './dropdown';
import {
  updateStepperUI,
  activateStopMarker,
  navigateToCurrentStop,
  fitCurrentTripBounds,
  setupKeyboardNav,
} from './stepper';

maplibregl.setWorkerUrl(workerUrl);

const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const DEFAULT_BOUNDS: [[number, number], [number, number]] = [
  [-125.0, 24.39],
  [-66.93, 49.38],
];

let mapInstance: maplibregl.Map | null = null;
let markerRecords: MarkerRecord[] = [];
let rawTrips: TripData[] = [];
let activeTripId: string | null = null;
let activeFilter: FilterCategory = 'all';

let fullTripCoordinates: [number, number][] | null = null;
let activeTripCoordinates: [number, number][] | null = null;
let activeTripMode: string = 'drive';
let overlayElements: RouteSvgOverlayElements = {
  routeSvg: null,
  routeGlowPath: null,
  routeCasingPath: null,
  routeLinePath: null,
  routeLeadGroup: null,
  routeLeadDot: null,
  routeLeadHalo: null,
};
let routeAnimationId: number | null = null;
let currentStopIndex = -1;
let currentTripStops: TripStop[] = [];
let currentTripStopIndices: number[] = [];
let tripCumulativeDistances: number[] = [];

let cleanupDropdownListeners: (() => void) | null = null;
let cleanupKeyNavListener: (() => void) | null = null;
let activeFlightId = 0;

function cancelCurrentAnimation() {
  if (routeAnimationId) {
    cancelAnimationFrame(routeAnimationId);
    routeAnimationId = null;
  }
  if (overlayElements.routeLeadGroup) {
    overlayElements.routeLeadGroup.style.display = 'none';
  }
}

export function setActiveTrip(tripId: string | null, fitBounds = false): void {
  if (!mapInstance) return;

  if (activeTripId === tripId && !fitBounds) {
    tripId = null;
  }
  activeTripId = tripId;

  const currentTrip = tripId ? rawTrips.find((t) => t.id === tripId) : undefined;
  updateTripsDropdownUI(activeTripId, currentTrip, rawTrips.length);

  if (!tripId || !currentTrip) {
    cancelCurrentAnimation();
    activeTripCoordinates = null;
    fullTripCoordinates = null;
    activeTripMode = 'drive';
    currentTripStops = [];
    currentStopIndex = -1;
    currentTripStopIndices = [];
    tripCumulativeDistances = [];
    if (overlayElements.routeGlowPath) overlayElements.routeGlowPath.removeAttribute('d');
    if (overlayElements.routeCasingPath) overlayElements.routeCasingPath.removeAttribute('d');
    if (overlayElements.routeLinePath) overlayElements.routeLinePath.removeAttribute('d');

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

    if (fitBounds) {
      mapInstance.fitBounds(DEFAULT_BOUNDS, {
        padding: window.innerWidth < 640 ? 20 : 40,
        bearing: 0,
        pitch: 0,
        duration: 900,
        essential: true,
      });
    }

    return;
  }

  cancelCurrentAnimation();

  // Close any open popups so the whole route can be viewed without obstruction
  markerRecords.forEach(({ popup }) => {
    if (popup && popup.isOpen()) {
      popup.remove();
    }
  });

  const theme = getTripTheme(currentTrip.color);

  // Set route coordinates on SVG overlay & trigger draw animation
  activeTripMode = currentTrip.mode || 'drive';
  currentTripStops = currentTrip.stops || [];
  currentStopIndex = -1;
  currentTripStopIndices = calculateStopIndices(currentTrip.geometry.coordinates, currentTripStops);
  tripCumulativeDistances = calculateCumulativeDistances(currentTrip.geometry.coordinates);
  fullTripCoordinates = currentTrip.geometry.coordinates;

  if (overlayElements.routeLeadDot) overlayElements.routeLeadDot.style.fill = theme.line;
  if (overlayElements.routeLeadHalo) overlayElements.routeLeadHalo.style.fill = theme.line;

  if (overlayElements.routeLinePath) {
    overlayElements.routeLinePath.style.stroke = theme.line;
  }
  if (overlayElements.routeGlowPath) {
    overlayElements.routeGlowPath.style.stroke = theme.glow;
  }

  routeAnimationId = startRouteDrawAnimation(
    mapInstance,
    currentTrip.geometry.coordinates,
    currentTrip.distanceMiles || 500,
    activeTripMode,
    tripCumulativeDistances,
    overlayElements,
    {
      getCurrentStopIndex: () => currentStopIndex,
      onUpdateCoords: (coords) => {
        activeTripCoordinates = coords;
      },
      onComplete: () => {
        routeAnimationId = null;
      },
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

  // Fit camera to the trip route if requested
  if (fitBounds && currentTrip.geometry.coordinates.length > 0) {
    fitCurrentTripBounds(mapInstance, fullTripCoordinates, markerRecords);
  }
}

export function applyCategoryFilter(category: FilterCategory): void {
  activeFilter = category;

  // 1. Toggle MapLibre markers
  markerRecords.forEach(({ element, popup, type }) => {
    const isVisible = category === 'all' || type === category;
    element.style.display = isVisible ? 'flex' : 'none';
    if (!isVisible && popup.isOpen()) {
      popup.remove();
    }
  });

  // 2. Update pill UI button states
  const pills = document.querySelectorAll<HTMLButtonElement>('.filter-pill[data-category]');
  pills.forEach((pill) => {
    const isSelected = pill.dataset.category === category;
    pill.classList.toggle('active', isSelected);
    pill.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
  });

  // 3. Update legend items visual cue
  const legendPark = document.querySelector<HTMLElement>('.legend-item-park');
  const legendCity = document.querySelector<HTMLElement>('.legend-item-city');
  const legendLandmark = document.querySelector<HTMLElement>('.legend-item-landmark');
  if (legendPark && legendCity && legendLandmark) {
    legendPark.classList.toggle('legend-active', category === 'park');
    legendPark.classList.toggle('legend-dimmed', category !== 'all' && category !== 'park');
    legendCity.classList.toggle('legend-active', category === 'city');
    legendCity.classList.toggle('legend-dimmed', category !== 'all' && category !== 'city');
    legendLandmark.classList.toggle('legend-active', category === 'landmark');
    legendLandmark.classList.toggle('legend-dimmed', category !== 'all' && category !== 'landmark');
  }

  // 4. Filter text directory cards below the map
  const placeCards = document.querySelectorAll<HTMLElement>('.place-card');
  let visibleCount = 0;
  placeCards.forEach((card) => {
    const cardType = card.dataset.type;
    const visible = category === 'all' || cardType === category;
    card.style.display = visible ? '' : 'none';
    if (visible) visibleCount++;
  });

  // 5. Update summary count in fallback directory
  const summaryCountEl = document.getElementById('summary-count');
  if (summaryCountEl) {
    summaryCountEl.textContent = `(${visibleCount})`;
  }
}

export function recenterMap(): void {
  if (!mapInstance) return;

  setActiveTrip(null, false);
  applyCategoryFilter('all');

  markerRecords.forEach(({ popup }) => {
    if (popup.isOpen()) {
      popup.remove();
    }
  });

  mapInstance.fitBounds(DEFAULT_BOUNDS, {
    padding: window.innerWidth < 640 ? 20 : 40,
    bearing: 0,
    pitch: 0,
    duration: 800,
    essential: true,
  });
}

export function flyToPlace(id: string, lat: number, lng: number, type: string): void {
  if (!mapInstance) return;
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
    const headerOffset = 90;
    const targetScroll = window.scrollY + rect.top - headerOffset;
    window.scrollTo({
      top: Math.max(0, targetScroll),
      behavior: 'smooth',
    });
  }

  mapInstance.flyTo({
    center: [lng, lat],
    zoom: 8.5,
    speed: 2.0,
    curve: 1.35,
    essential: true,
  });

  const record = markerRecords.find(
    (r) =>
      r.id === id || (Math.abs(r.lat - lat) < 0.0001 && Math.abs(r.lng - lng) < 0.0001)
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

  const rawPlaces: PlaceData[] = JSON.parse(mapEl.dataset.places);
  rawTrips = JSON.parse(document.getElementById('trips-json')?.textContent || '[]');

  const map = new maplibregl.Map({
    container: mapEl,
    style: MAP_STYLE,
    center: [-98.35, 39.5],
    zoom: 3.5,
    minZoom: 1.5,
    maxZoom: 19,
    attributionControl: false,
    dragRotate: false,
    touchPitch: false,
    pitchWithRotate: false,
    fadeDuration: 0,
    maxTileCacheSize: 150,
    renderWorldCopies: false,
    crossSourceCollisions: false,
    collectResourceTiming: false,
  });
  mapInstance = map;

  const navControl = new maplibregl.NavigationControl({ showCompass: false });
  map.addControl(navControl, 'top-left');

  const ctrlGroup = mapEl.querySelector('.maplibregl-ctrl-top-left .maplibregl-ctrl-group');
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

  // Tune drag pan momentum & physics for fluid feel
  map.dragPan.enable({
    linearity: 0.25,
    maxSpeed: 2200,
    deceleration: 2200,
  });

  // Keep scroll zoom smoothly enabled at all times
  map.scrollZoom.enable();
  map.scrollZoom.setWheelZoomRate(1 / 450);

  // Setup SVG route overlay inside canvas container
  overlayElements = createRouteSvgOverlay(mapEl);

  map.on('render', () => {
    updateRouteSvg(map, activeTripCoordinates, overlayElements);
  });

  map.on('dragstart', () => {
    if (routeAnimationId) {
      cancelAnimationFrame(routeAnimationId);
      routeAnimationId = null;
      if (overlayElements.routeLeadGroup) overlayElements.routeLeadGroup.style.display = 'none';
      if (
        currentStopIndex > 0 &&
        currentTripStopIndices[currentStopIndex] !== undefined &&
        fullTripCoordinates
      ) {
        activeTripCoordinates = fullTripCoordinates.slice(
          0,
          currentTripStopIndices[currentStopIndex] + 1
        );
        updateRouteSvg(map, activeTripCoordinates, overlayElements);
      } else if (currentStopIndex === 0) {
        activeTripCoordinates = null;
        updateRouteSvg(map, activeTripCoordinates, overlayElements);
      }
    }
  });

  map.on('load', () => {
    map.fitBounds(DEFAULT_BOUNDS, {
      padding: window.innerWidth < 640 ? 20 : 40,
      duration: 0,
    });
  });

  // Create markers with callbacks
  markerRecords = createMarkers(map, mapEl, rawPlaces, {
    onSelectTrip: (tripId) => {
      setActiveTrip(tripId, true);
    },
    onMarkerClick: (place) => {
      if (activeTripId && currentTripStops.length > 0 && fullTripCoordinates) {
        const stopIdx = currentTripStops.findIndex(
          (s) =>
            (s.placeId && s.placeId === place.id) ||
            (Math.abs(s.lat - place.lat) < 0.001 && Math.abs(s.lng - place.lng) < 0.001) ||
            s.name.toLowerCase().trim() === place.name.toLowerCase().trim()
        );
        if (stopIdx !== -1) {
          currentStopIndex = stopIdx;
          const currentTrip = rawTrips.find((t) => t.id === activeTripId);
          updateStepperUI(currentStopIndex, currentTripStops, currentTrip);
          cancelCurrentAnimation();
          if (stopIdx === 0) {
            activeTripCoordinates = [fullTripCoordinates[0], fullTripCoordinates[0]];
          } else if (currentTripStopIndices[stopIdx] !== undefined) {
            activeTripCoordinates = fullTripCoordinates.slice(
              0,
              currentTripStopIndices[stopIdx] + 1
            );
          }
          updateRouteSvg(map, activeTripCoordinates, overlayElements);
        }
      }
    },
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
  const stepperPrev = document.getElementById('stepper-prev') as HTMLButtonElement | null;
  const stepperNext = document.getElementById('stepper-next') as HTMLButtonElement | null;
  const stepperContent = document.getElementById('stepper-content');
  const stepperFit = document.getElementById('stepper-fit') as HTMLButtonElement | null;

  if (stepperPrev) {
    stepperPrev.onclick = () => {
      if (currentStopIndex > 0) {
        const toIdx = currentStopIndex - 1;
        currentStopIndex = toIdx;
        cancelCurrentAnimation();
        if (toIdx === 0) {
          activeTripCoordinates = null;
        } else if (fullTripCoordinates && currentTripStopIndices[toIdx] !== undefined) {
          activeTripCoordinates = fullTripCoordinates.slice(0, currentTripStopIndices[toIdx] + 1);
        }
        updateRouteSvg(map, activeTripCoordinates, overlayElements);
        const stop = currentTripStops[currentStopIndex];
        const currentTrip = rawTrips.find((t) => t.id === activeTripId);
        updateStepperUI(currentStopIndex, currentTripStops, currentTrip);
        navigateToCurrentStop(map, stop, markerRecords);
      } else if (currentStopIndex === 0) {
        cancelCurrentAnimation();
        currentStopIndex = -1;
        activeTripCoordinates = fullTripCoordinates;
        updateRouteSvg(map, activeTripCoordinates, overlayElements);
        const currentTrip = rawTrips.find((t) => t.id === activeTripId);
        updateStepperUI(currentStopIndex, currentTripStops, currentTrip);
        fitCurrentTripBounds(map, fullTripCoordinates, markerRecords);
      }
    };
  }

  if (stepperNext) {
    stepperNext.onclick = () => {
      if (currentStopIndex < currentTripStops.length - 1) {
        const fromIdx = currentStopIndex;
        const toIdx = currentStopIndex + 1;
        currentStopIndex = toIdx;

        if (fromIdx < 0) {
          cancelCurrentAnimation();
          activeTripCoordinates = null;
          updateRouteSvg(map, activeTripCoordinates, overlayElements);
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
            overlayElements,
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
              },
            }
          );
        }
      }
    };
  }

  if (stepperContent) {
    const handleContentAction = () => {
      if (currentStopIndex < 0) {
        currentStopIndex = 0;
        cancelCurrentAnimation();
        activeTripCoordinates = null;
        updateRouteSvg(map, activeTripCoordinates, overlayElements);
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
      cancelCurrentAnimation();
      currentStopIndex = -1;
      activeTripCoordinates = fullTripCoordinates;
      updateRouteSvg(map, activeTripCoordinates, overlayElements);
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
      } else if (currentStopIndex !== -1 && stepperFit) {
        stepperFit.click();
      }
    },
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
    getActiveTripId: () => activeTripId,
  });

  // Legend listeners
  const legendPark = document.querySelector<HTMLElement>('.legend-item-park');
  if (legendPark) {
    const handlePark = () => applyCategoryFilter(activeFilter === 'park' ? 'all' : 'park');
    legendPark.onclick = handlePark;
    legendPark.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handlePark();
      }
    };
  }

  const legendCity = document.querySelector<HTMLElement>('.legend-item-city');
  if (legendCity) {
    const handleCity = () => applyCategoryFilter(activeFilter === 'city' ? 'all' : 'city');
    legendCity.onclick = handleCity;
    legendCity.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleCity();
      }
    };
  }

  const legendLandmark = document.querySelector<HTMLElement>('.legend-item-landmark');
  if (legendLandmark) {
    const handleLandmark = () =>
      applyCategoryFilter(activeFilter === 'landmark' ? 'all' : 'landmark');
    legendLandmark.onclick = handleLandmark;
    legendLandmark.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleLandmark();
      }
    };
  }

  // Apply active category filter state
  applyCategoryFilter(activeFilter);

  // Attach click and keyboard listeners to all place cards in directory
  const placeCards = document.querySelectorAll<HTMLElement>('.place-card');
  placeCards.forEach((card) => {
    const handleSelect = () => {
      const id = card.dataset.id || '';
      const lat = parseFloat(card.dataset.lat || '0');
      const lng = parseFloat(card.dataset.lng || '0');
      const type = card.dataset.type || 'city';
      if (lat && lng && (lat !== 0 || lng !== 0)) {
        flyToPlace(id, lat, lng, type);
      }
    };

    card.onclick = handleSelect;
    card.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleSelect();
      }
    };
  });

  requestAnimationFrame(() => {
    map.resize();
  });
  setTimeout(() => {
    map.resize();
  }, 200);
}

export function cleanupTravelMap(): void {
  if (mapInstance) {
    try {
      mapInstance.remove();
    } catch (e) {}
    mapInstance = null;
  }
  markerRecords = [];
  activeTripId = null;
  cancelCurrentAnimation();
  currentTripStops = [];
  currentStopIndex = -1;
  currentTripStopIndices = [];
  tripCumulativeDistances = [];
  activeTripCoordinates = null;
  fullTripCoordinates = null;

  if (cleanupDropdownListeners) {
    cleanupDropdownListeners();
    cleanupDropdownListeners = null;
  }
  if (cleanupKeyNavListener) {
    cleanupKeyNavListener();
    cleanupKeyNavListener = null;
  }

  overlayElements = {
    routeSvg: null,
    routeGlowPath: null,
    routeCasingPath: null,
    routeLinePath: null,
    routeLeadGroup: null,
    routeLeadDot: null,
    routeLeadHalo: null,
  };
}
