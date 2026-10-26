import * as maplibregl from 'maplibre-gl';
import { getTripTheme } from '../../utils/travelColors';
import type { PlaceData, MarkerRecord } from './types';

export function createMarkers(
  map: maplibregl.Map,
  mapEl: HTMLElement,
  places: PlaceData[],
  callbacks: {
    onSelectTrip: (tripId: string) => void;
    onMarkerClick: (place: PlaceData) => void;
  }
): MarkerRecord[] {
  const records: MarkerRecord[] = [];

  for (const place of places) {
    const hasBlurb = Boolean(place.blurb && place.blurb.trim().length > 0);
    const isPark = place.type === 'park';
    const isLandmark = place.type === 'landmark';

    const iconHtml = isPark
      ? `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <path d="M12 2L4 12h3.5L5 17h4.5v5h5v-5H19l-2.5-5H20L12 2z"/>
        </svg>`
      : isLandmark
        ? `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
          <path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z"/>
        </svg>`
        : `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <path d="M15 2H9c-1.1 0-2 .9-2 2v16h10V4c0-1.1-.9-2-2-2zm-4 4h2v2h-2V6zm0 4h2v2h-2v-2zm0 4h2v2h-2v-2z"/>
        </svg>`;

    const typeTag = isPark ? 'Park' : isLandmark ? 'Landmark' : 'City';
    const tagClass = isPark ? 'tag-park' : isLandmark ? 'tag-landmark' : 'tag-city';

    let tripsHtml = '';
    if (place.trips && place.trips.length > 0) {
      tripsHtml = `
        <div class="popup-trips-section">
          ${place.trips
            .map((t) => {
              const theme = getTripTheme(t.color);
              const stopIndicesStr = t.stopIndices.join(', ');
              const modeLabel = t.mode === 'train' ? 'Train' : t.mode === 'flight' ? 'Flight' : 'Road Trip';
              let stopDesc = `${modeLabel} • Stop ${stopIndicesStr} of ${t.totalStops}`;
              if (t.stopIndices.includes(1) && t.stopIndices.includes(t.totalStops)) {
                stopDesc = `${modeLabel} • Start & Finish ★`;
              } else if (t.stopIndices.length > 1) {
                stopDesc = `${modeLabel} • Stops ${stopIndicesStr} of ${t.totalStops}`;
              } else if (t.stopIndices.includes(1)) {
                stopDesc = `${modeLabel} • Start`;
              } else if (t.stopIndices.includes(t.totalStops)) {
                stopDesc = `${modeLabel} • Finish`;
              }

              return `
                <div class="popup-trip-pill" style="--trip-accent: ${theme.line}; --trip-glow: ${theme.glow}; --trip-bg: ${theme.bg}; --trip-border: ${theme.border};">
                  <div class="popup-trip-content">
                    <span class="popup-trip-dot" aria-hidden="true"></span>
                    <span class="popup-trip-text">Part of <strong>${t.tripName}</strong></span>
                    <span class="popup-trip-stop-tag">(${stopDesc})</span>
                  </div>
                  <button type="button" class="btn-fit-trip" data-trip-id="${t.tripId}" title="View ${t.tripName} route on map">
                    <span>View Route &rarr;</span>
                  </button>
                </div>
              `;
            })
            .join('')}
        </div>
      `;
    }

    const popupContent = hasBlurb
      ? `<div class="popup-card">
          <header class="popup-header">
            <span class="popup-type-tag ${tagClass}">
              ${typeTag}
            </span>
            <h3 class="popup-title">${place.name}</h3>
          </header>
          ${
            place.photo
              ? `<div class="popup-photo-container">
                  <img src="${place.photo}" alt="${place.name}" class="popup-img" loading="lazy" />
                </div>`
              : ''
          }
          <p class="popup-blurb">${place.blurb}</p>
          ${tripsHtml}
          ${
            place.link
              ? `<div class="popup-footer"><a href="${place.link}" class="popup-link">Read full story &rarr;</a></div>`
              : ''
          }
        </div>`
      : `<div class="popup-compact">
          <span class="popup-type-tag ${tagClass}">
            ${typeTag}
          </span>
          <h3 class="popup-title">${place.name}</h3>
          ${tripsHtml}
        </div>`;

    const popup = new maplibregl.Popup({
      offset: 16,
      closeButton: true,
      closeOnClick: true,
      className: 'custom-maplibre-popup',
      maxWidth: '320px',
    })
      .setLngLat([place.lng, place.lat])
      .setHTML(popupContent);

    popup.on('open', () => {
      const popupEl = popup.getElement();
      if (!popupEl) return;
      const fitBtns = popupEl.querySelectorAll<HTMLButtonElement>('.btn-fit-trip');
      fitBtns.forEach((btn) => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const tid = btn.dataset.tripId;
          if (tid) {
            callbacks.onSelectTrip(tid);
            popup.remove();
          }
        };
      });
    });

    const el = document.createElement('div');
    el.className = 'custom-map-icon';
    el.dataset.id = place.id;
    el.dataset.type = place.type;
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', place.name);

    const pin = document.createElement('div');
    pin.className = `pin-marker ${
      isPark ? 'pin-park' : isLandmark ? 'pin-landmark' : 'pin-city'
    }`;
    pin.title = place.name;
    pin.innerHTML = iconHtml;
    el.appendChild(pin);

    const stopBadge = document.createElement('span');
    stopBadge.className = 'trip-stop-badge';
    stopBadge.setAttribute('aria-hidden', 'true');
    el.appendChild(stopBadge);

    // Seamless drag forwarding
    let isDown = false;
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastY = 0;
    let didDrag = false;
    let velX = 0;
    let velY = 0;
    let lastTime = 0;

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      isDown = true;
      didDrag = false;
      startX = e.clientX;
      startY = e.clientY;
      lastX = e.clientX;
      lastY = e.clientY;
      lastTime = performance.now();
      velX = 0;
      velY = 0;
      try {
        el.setPointerCapture(e.pointerId);
      } catch (err) {}
    });

    el.addEventListener('pointermove', (e) => {
      if (!isDown) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      const totalDist = Math.hypot(e.clientX - startX, e.clientY - startY);

      if (totalDist > 4) {
        didDrag = true;
        mapEl.classList.add('is-dragging');

        map.panBy([-dx, -dy], { duration: 0 });

        const now = performance.now();
        const dt = Math.max(1, now - lastTime);
        velX = dx / dt;
        velY = dy / dt;
        lastTime = now;
        lastX = e.clientX;
        lastY = e.clientY;
      }
    });

    const onPointerUp = (e: PointerEvent) => {
      if (!isDown) return;
      isDown = false;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch (err) {}
      mapEl.classList.remove('is-dragging');

      if (didDrag) {
        const speed = Math.hypot(velX, velY);
        if (speed > 0.12) {
          const momentumFactor = Math.min(speed * 280, 420);
          map.panBy([-velX * momentumFactor, -velY * momentumFactor], {
            duration: Math.min(800, Math.max(250, speed * 550)),
            easing: (t) => t * (2 - t),
          });
        }
      }
    };

    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', () => {
      isDown = false;
      didDrag = false;
      mapEl.classList.remove('is-dragging');
    });

    el.addEventListener(
      'click',
      (e) => {
        if (didDrag) {
          e.stopPropagation();
          e.preventDefault();
          didDrag = false;
          return;
        }
        const pinEl = el.querySelector('.pin-marker');
        if (pinEl) {
          pinEl.classList.add('pin-pulse');
          setTimeout(() => pinEl.classList.remove('pin-pulse'), 2400);
        }
        callbacks.onMarkerClick(place);
      },
      true
    );

    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        popup.isOpen() ? popup.remove() : popup.addTo(map);
      }
    });

    const marker = new maplibregl.Marker({
      element: el,
      anchor: 'center',
    })
      .setLngLat([place.lng, place.lat])
      .setPopup(popup)
      .addTo(map);

    records.push({
      id: place.id,
      name: place.name,
      marker,
      popup,
      element: el,
      type: place.type,
      lat: place.lat,
      lng: place.lng,
      place,
    });
  }

  return records;
}
