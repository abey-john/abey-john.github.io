import type * as maplibregl from 'maplibre-gl';
import type { TripStop, TripData, MarkerRecord } from './types';
import { isImageModalOpen } from './image-modal';

export function updateStepperUI(
  currentStopIndex: number,
  currentTripStops: TripStop[],
  activeTrip: TripData | undefined
): void {
  const stepperBadge = document.getElementById('stepper-badge');
  const stepperCounter = document.getElementById('stepper-counter');
  const stepperName = document.getElementById('stepper-name');
  const stepperSummary = document.getElementById('stepper-summary');
  const stepperContent = document.getElementById('stepper-content');
  const stepperPrev = document.getElementById(
    'stepper-prev'
  ) as HTMLButtonElement | null;
  const stepperNext = document.getElementById(
    'stepper-next'
  ) as HTMLButtonElement | null;
  const stepperEl = document.getElementById('itinerary-stepper');

  if (!currentTripStops.length) return;
  const total = currentTripStops.length;

  if (currentStopIndex < 0) {
    if (stepperBadge) {
      stepperBadge.innerHTML = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="19" r="3"></circle><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"></path><circle cx="18" cy="5" r="3"></circle></svg>`;
    }
    if (stepperCounter) {
      stepperCounter.textContent = '';
      stepperCounter.style.display = 'none';
    }
    if (stepperName) stepperName.textContent = 'Trip Overview';
    if (stepperSummary) {
      if (activeTrip?.summary) {
        stepperSummary.textContent = activeTrip.summary;
        stepperSummary.title = activeTrip.summary;
        stepperSummary.style.display = '-webkit-box';
        stepperEl?.classList.add('has-summary');
      } else {
        stepperSummary.textContent = '';
        stepperSummary.removeAttribute('title');
        stepperSummary.style.display = 'none';
        stepperEl?.classList.remove('has-summary');
      }
    }
    if (stepperContent) {
      stepperContent.title = activeTrip?.summary
        ? `${activeTrip.summary} • Start itinerary (Stop 1)`
        : 'Start itinerary (Stop 1)';
    }
    if (stepperPrev) {
      stepperPrev.disabled = true;
      stepperPrev.title = 'Previous stop (←)';
    }
    if (stepperNext) {
      stepperNext.disabled = total === 0;
      stepperNext.title = 'Start itinerary (→)';
    }
    return;
  }

  const stop = currentTripStops[currentStopIndex];
  stepperEl?.classList.remove('has-summary');
  if (stepperSummary) {
    stepperSummary.textContent = '';
    stepperSummary.removeAttribute('title');
    stepperSummary.style.display = 'none';
  }
  if (stepperBadge) stepperBadge.textContent = String(currentStopIndex + 1);
  if (stepperCounter) {
    stepperCounter.textContent = `Stop ${currentStopIndex + 1} of ${total}`;
    stepperCounter.style.display = '';
  }
  if (stepperName) stepperName.textContent = stop.name;
  if (stepperContent) stepperContent.title = `Re-center on ${stop.name}`;
  if (stepperPrev) {
    stepperPrev.disabled = false;
    stepperPrev.title =
      currentStopIndex === 0 ? 'Trip Overview (←)' : 'Previous stop (←)';
  }
  if (stepperNext) {
    stepperNext.disabled = currentStopIndex >= total - 1;
    stepperNext.title =
      currentStopIndex >= total - 1 ? 'Trip completed' : 'Next stop (→)';
  }
}

export function activateStopMarker(
  stop: TripStop,
  markerRecords: MarkerRecord[]
): void {
  const cleanStr = (s: string) =>
    (s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '')
      .trim();

  const targetName = cleanStr(stop.name);

  const record = markerRecords.find(
    (r) =>
      (stop.placeId && r.id === stop.placeId) ||
      cleanStr(r.place.name) === targetName ||
      (Math.abs(r.lat - stop.lat) < 0.04 && Math.abs(r.lng - stop.lng) < 0.04)
  );

  markerRecords.forEach(({ popup }) => {
    if ((!record || popup !== record.popup) && popup.isOpen()) popup.remove();
  });

  if (record) {
    if (!record.popup.isOpen()) {
      record.marker.togglePopup();
    }
    const pinEl = record.element.querySelector('.pin-marker');
    if (pinEl) {
      pinEl.classList.add('pin-pulse');
      setTimeout(() => pinEl.classList.remove('pin-pulse'), 2400);
    }
  }
}

export function navigateToCurrentStop(
  map: maplibregl.Map,
  stop: TripStop,
  markerRecords: MarkerRecord[]
): void {
  // Dismiss any existing open popup so it doesn't linger or fly across the screen
  markerRecords.forEach(({ popup }) => {
    if (popup.isOpen()) popup.remove();
  });

  map.flyTo({
    center: [stop.lng, stop.lat],
    zoom: 9.5,
    speed: 1.25,
    curve: 1.42,
    essential: true
  });

  let done = false;
  const onFlightDone = () => {
    if (done) return;
    done = true;
    activateStopMarker(stop, markerRecords);
  };
  map.once('moveend', onFlightDone);
  setTimeout(onFlightDone, 1800);
}

export function fitCurrentTripBounds(
  map: maplibregl.Map,
  coordsToFit: [number, number][] | null,
  markerRecords: MarkerRecord[]
): void {
  if (!coordsToFit || !coordsToFit.length) return;

  // Close any open popup cards for a clean unobstructed overview
  markerRecords.forEach(({ popup, element }) => {
    if (popup && popup.isOpen()) {
      popup.remove();
    }
    const pinEl = element.querySelector('.pin-marker');
    if (pinEl) pinEl.classList.remove('pin-pulse');
  });

  let minLng = Infinity,
    minLat = Infinity,
    maxLng = -Infinity,
    maxLat = -Infinity;
  for (const [lng, lat] of coordsToFit) {
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  }
  if (isFinite(minLng) && isFinite(minLat)) {
    const centerLng = (minLng + maxLng) / 2;
    const centerLat = (minLat + maxLat) / 2;
    const currentCenter = map.getCenter();

    // Calculate approximate great-circle distance in miles between current view and target trip
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(centerLat - currentCenter.lat);
    const dLng = toRad(centerLng - currentCenter.lng);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(currentCenter.lat)) *
        Math.cos(toRad(centerLat)) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const approxMiles = 3959 * c;

    // Domestic/regional trips keep the fast snappy 900ms duration.
    // Intercontinental trips (e.g. US <-> Switzerland, ~4,500+ miles) scale to 2200ms
    // so flying to/from Europe feels smooth and majestic rather than an instant warp.
    const duration = approxMiles > 2500 ? 2200 : 900;

    map.fitBounds(
      [
        [minLng, minLat],
        [maxLng, maxLat]
      ],
      {
        padding: window.innerWidth < 640 ? 40 : 80,
        duration,
        essential: true
      }
    );
  }
}

export function setupKeyboardNav(callbacks: {
  isTripActive: () => boolean;
  onNext: () => void;
  onPrev: () => void;
  onEscape: () => void;
}): () => void {
  const listener = (e: KeyboardEvent) => {
    const activeEl = document.activeElement;
    if (
      activeEl &&
      (activeEl.tagName === 'INPUT' ||
        activeEl.tagName === 'TEXTAREA' ||
        activeEl.tagName === 'SELECT' ||
        (activeEl as HTMLElement).isContentEditable)
    ) {
      return;
    }

    if (!callbacks.isTripActive() || isImageModalOpen()) return;

    if (e.key === 'ArrowRight') {
      e.preventDefault();
      callbacks.onNext();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      callbacks.onPrev();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      callbacks.onEscape();
    }
  };

  document.addEventListener('keydown', listener);
  return () => {
    document.removeEventListener('keydown', listener);
  };
}
