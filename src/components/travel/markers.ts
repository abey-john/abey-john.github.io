import * as maplibregl from 'maplibre-gl';
import { getTripTheme } from '../../utils/travelColors';
import type { PlaceData, MarkerRecord } from './types';

function ensurePopupInView(
  map: maplibregl.Map,
  mapEl: HTMLElement,
  popup: maplibregl.Popup
): void {
  requestAnimationFrame(() => {
    if (!popup.isOpen() || map.isMoving()) return;
    const popupEl = popup.getElement();
    if (!popupEl || !popupEl.isConnected) return;

    const mapRect = mapEl.getBoundingClientRect();
    const popupRect = popupEl.getBoundingClientRect();

    if (
      mapRect.width === 0 ||
      mapRect.height === 0 ||
      popupRect.width === 0 ||
      popupRect.height === 0
    ) {
      return;
    }

    // Safe padding from map edges (clearing the floating filter bar only if genuinely clipped)
    const PADDING = {
      top: 54,
      bottom: 36,
      left: 16,
      right: 16
    };

    let dx = 0;
    let dy = 0;

    if (popupRect.top < mapRect.top + PADDING.top) {
      dy = popupRect.top - (mapRect.top + PADDING.top);
    } else if (popupRect.bottom > mapRect.bottom - PADDING.bottom) {
      dy = popupRect.bottom - (mapRect.bottom - PADDING.bottom);
    }

    if (popupRect.left < mapRect.left + PADDING.left) {
      dx = popupRect.left - (mapRect.left + PADDING.left);
    } else if (popupRect.right > mapRect.right - PADDING.right) {
      dx = popupRect.right - (mapRect.right - PADDING.right);
    }

    if (Math.abs(dx) > 16 || Math.abs(dy) > 16) {
      map.panBy([dx, dy], {
        duration: 260,
        easing: (t) => t * (2 - t)
      });
    }
  });
}

export function createMarkers(
  map: maplibregl.Map,
  mapEl: HTMLElement,
  places: PlaceData[],
  callbacks: {
    onSelectTrip: (tripId: string) => void;
    onMarkerClick: (place: PlaceData) => void;
    onOpenImageModal?: (data: {
      url: string;
      name: string;
      tag?: string;
      tagClass?: string;
      blurb?: string;
    }) => void;
  }
): MarkerRecord[] {
  // Pre-cache place photos in background so marker popups render instantaneously
  if (typeof window !== 'undefined') {
    places.forEach((p) => {
      if (p.photo) {
        const webpUrl = p.photo.replace(/\.(png|jpe?g)$/i, '.webp');
        const img = new Image();
        img.decoding = 'async';
        img.src = webpUrl;
      }
    });
  }

  const records: MarkerRecord[] = [];

  for (const place of places) {
    const hasBlurb = Boolean(place.blurb && place.blurb.trim().length > 0);
    const hasDetails = hasBlurb || Boolean(place.photo);
    const isPark = place.type === 'park';
    const isLandmark = place.type === 'landmark';
    const isVenue = place.type === 'venue';

    const iconHtml = isPark
      ? `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <path d="M12 2L4 12h3.5L5 17h4.5v5h5v-5H19l-2.5-5H20L12 2z"/>
        </svg>`
      : isLandmark
        ? `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
          <path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z"/>
        </svg>`
        : isVenue
          ? `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/>
            <path d="M13 5v2"/>
            <path d="M13 17v2"/>
            <path d="M13 11v2"/>
          </svg>`
          : `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <path d="M15 2H9c-1.1 0-2 .9-2 2v16h10V4c0-1.1-.9-2-2-2zm-4 4h2v2h-2V6zm0 4h2v2h-2v-2zm0 4h2v2h-2v-2z"/>
        </svg>`;

    const typeTag = isPark
      ? 'Park'
      : isLandmark
        ? 'Landmark'
        : isVenue
          ? 'Venue'
          : 'City';
    const tagClass = isPark
      ? 'tag-park'
      : isLandmark
        ? 'tag-landmark'
        : isVenue
          ? 'tag-venue'
          : 'tag-city';

    let tripsHtml = '';
    if (place.trips && place.trips.length > 0) {
      tripsHtml = `
        <div class="popup-trips-section">
          ${place.trips
            .map((t) => {
              const theme = getTripTheme(t.color);
              const isStartAndFinish =
                t.stopIndices.includes(1) &&
                t.stopIndices.includes(t.totalStops);
              const stopIndicesStr = t.stopIndices.join(', ');
              const stopDesc = isStartAndFinish
                ? 'Start & Finish'
                : t.stopIndices.length > 1
                  ? `Stops ${stopIndicesStr} of ${t.totalStops}`
                  : `Stop ${stopIndicesStr} of ${t.totalStops}`;

              return `
                <button type="button" class="popup-trip-pill btn-fit-trip" data-trip-id="${t.tripId}" title="View ${t.tripName} route on map" style="--trip-accent: ${theme.line}; --trip-glow: ${theme.glow}; --trip-bg: ${theme.bg}; --trip-border: ${theme.border};">
                  <span class="popup-trip-dot" aria-hidden="true"></span>
                  <div class="popup-trip-info">
                    <span class="popup-trip-name">${t.tripName}</span>
                    <span class="popup-trip-stop">${stopDesc}</span>
                  </div>
                  <span class="popup-trip-arrow" aria-hidden="true">&rarr;</span>
                </button>
              `;
            })
            .join('')}
        </div>
      `;
    }

    const hasPhoto = Boolean(place.photo);
    const hasTrips = Boolean(place.trips && place.trips.length > 0);
    const popupClass = hasPhoto
      ? 'custom-maplibre-popup popup-has-photo'
      : 'custom-maplibre-popup popup-no-photo';
    const popupMaxWidth = hasPhoto
      ? '240px'
      : hasTrips || hasBlurb
        ? '220px'
        : '170px';

    const popupContent = hasDetails
      ? `<div class="popup-card ${hasPhoto ? 'has-photo' : 'no-photo'}">
          <header class="popup-header">
            <span class="popup-type-tag ${tagClass}">
              ${typeTag}
            </span>
            <h3 class="popup-title">${place.name}</h3>
          </header>
          ${
            place.photo
              ? `<div class="popup-photo-container">
                  <button
                    type="button"
                    class="popup-photo-btn"
                    aria-label="Expand image of ${place.name}"
                    title="Click to expand"
                    data-photo-url="${place.photo}"
                    data-photo-name="${place.name}"
                    data-photo-tag="${typeTag}"
                    data-photo-tag-class="${tagClass}"
                  >
                    <picture>
                      <source srcset="${place.photo.replace(/\.(png|jpe?g)$/i, '.webp')}" type="image/webp" />
                      <img src="${place.photo}" alt="${place.name}" class="popup-img" width="216" height="216" loading="eager" decoding="async" />
                    </picture>
                    <span class="popup-photo-expand-badge" aria-hidden="true" title="Expand photo">
                      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="15 3 21 3 21 9"></polyline>
                        <polyline points="9 21 3 21 3 15"></polyline>
                        <line x1="21" y1="3" x2="14" y2="10"></line>
                        <line x1="3" y1="21" x2="10" y2="14"></line>
                      </svg>
                    </span>
                  </button>
                </div>`
              : ''
          }
          ${hasBlurb ? `<p class="popup-blurb">${place.blurb}</p>` : ''}
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
      className: popupClass,
      maxWidth: popupMaxWidth
    })
      .setLngLat([place.lng, place.lat])
      .setHTML(popupContent);

    popup.on('open', () => {
      ensurePopupInView(map, mapEl, popup);

      const popupEl = popup.getElement();
      if (!popupEl) return;

      const photoBtn =
        popupEl.querySelector<HTMLButtonElement>('.popup-photo-btn');
      if (photoBtn) {
        photoBtn.onclick = (e) => {
          e.stopPropagation();
          const photoUrl = photoBtn.dataset.photoUrl;
          if (photoUrl && callbacks.onOpenImageModal) {
            callbacks.onOpenImageModal({
              url: photoUrl,
              name: photoBtn.dataset.photoName || place.name,
              tag: photoBtn.dataset.photoTag || typeTag,
              tagClass: photoBtn.dataset.photoTagClass || tagClass,
              blurb: place.blurb
            });
          }
        };
      }

      const fitBtns =
        popupEl.querySelectorAll<HTMLButtonElement>('.btn-fit-trip');
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
    el.className = `custom-map-icon${isVenue ? ' custom-map-icon-venue' : ''}`;
    el.dataset.id = place.id;
    el.dataset.type = place.type;
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', place.name);
    if (isVenue) {
      el.style.display = 'none';
    }

    const pin = document.createElement('div');
    pin.className = `pin-marker ${
      isPark
        ? 'pin-park'
        : isLandmark
          ? 'pin-landmark'
          : isVenue
            ? 'pin-venue'
            : 'pin-city'
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
            easing: (t) => t * (2 - t)
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
      anchor: 'center'
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
      place
    });
  }

  return records;
}
