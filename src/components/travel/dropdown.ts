import { getTripTheme } from '../../utils/travelColors';
import type { TripData } from './types';

export function closeTripsDropdown(): void {
  const dropdownContainer = document.getElementById('trips-dropdown-container');
  const dropdownTrigger = document.getElementById('trips-dropdown-trigger');
  if (dropdownContainer) {
    dropdownContainer.classList.remove('open');
  }
  if (dropdownTrigger) {
    dropdownTrigger.setAttribute('aria-expanded', 'false');
  }
}

export function toggleTripsDropdown(): void {
  const dropdownContainer = document.getElementById('trips-dropdown-container');
  const dropdownTrigger = document.getElementById('trips-dropdown-trigger');
  if (!dropdownContainer || !dropdownTrigger) return;
  const isOpen = dropdownContainer.classList.contains('open');
  if (isOpen) {
    closeTripsDropdown();
  } else {
    dropdownContainer.classList.add('open');
    dropdownTrigger.setAttribute('aria-expanded', 'true');
  }
}

export function updateTripsDropdownUI(
  activeTripId: string | null,
  trip: TripData | undefined,
  totalTripsCount: number
): void {
  const trigger = document.getElementById('trips-dropdown-trigger') as HTMLButtonElement | null;
  const triggerLabel = document.getElementById('trips-trigger-label');
  const triggerCount = document.getElementById('trips-trigger-count');
  const triggerIcon = document.getElementById('trips-trigger-icon');
  const clearBtn = document.getElementById('trips-dropdown-clear') as HTMLButtonElement | null;
  const dropdownItems = document.querySelectorAll<HTMLButtonElement>('.trips-dropdown-item');

  dropdownItems.forEach((item) => {
    const isSelected = item.dataset.tripId === activeTripId;
    item.classList.toggle('selected', isSelected);
    item.setAttribute('aria-selected', isSelected ? 'true' : 'false');
  });

  if (clearBtn) {
    clearBtn.style.display = activeTripId ? 'inline-block' : 'none';
  }

  if (!activeTripId || !trip) {
    if (trigger) {
      trigger.classList.remove('active');
      trigger.setAttribute('aria-pressed', 'false');
      trigger.style.removeProperty('--active-trip-color');
      trigger.style.removeProperty('--active-trip-glow');
    }
    if (triggerLabel) triggerLabel.textContent = 'Trips';
    if (triggerCount) triggerCount.textContent = String(totalTripsCount);
    if (triggerIcon) {
      triggerIcon.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="19" r="3"></circle><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"></path><circle cx="18" cy="5" r="3"></circle></svg>`;
    }
    return;
  }

  const theme = getTripTheme(trip.color);

  if (trigger) {
    trigger.classList.add('active');
    trigger.setAttribute('aria-pressed', 'true');
    trigger.style.setProperty('--active-trip-color', theme.line);
    trigger.style.setProperty('--active-trip-glow', theme.glow);
  }
  if (triggerLabel) triggerLabel.textContent = trip.name;
  if (triggerCount) {
    triggerCount.textContent = trip.distanceMiles > 0 ? `${trip.distanceMiles} mi` : `${trip.stops.length} stops`;
  }

  if (triggerIcon) {
    if (trip.mode === 'train') {
      triggerIcon.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="16" rx="2"></rect><path d="M4 11h16"></path><path d="M12 3v8"></path><path d="m8 19-2 3"></path><path d="m16 19 2 3"></path><circle cx="8" cy="15" r="1" fill="currentColor"></circle><circle cx="16" cy="15" r="1" fill="currentColor"></circle></svg>`;
    } else if (trip.mode === 'flight') {
      triggerIcon.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.3c.4-.2.6-.6.5-1.1z"></path></svg>`;
    } else {
      triggerIcon.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"></path><circle cx="7" cy="17" r="2"></circle><path d="M9 17h6"></path><circle cx="17" cy="17" r="2"></circle></svg>`;
    }
  }
}

export function setupTripsDropdown(callbacks: {
  onSelectTrip: (tripId: string | null) => void;
  getActiveTripId: () => string | null;
}): () => void {
  const dropdownContainer = document.getElementById('trips-dropdown-container');
  const dropdownTrigger = document.getElementById('trips-dropdown-trigger');
  const dropdownClear = document.getElementById('trips-dropdown-clear');
  const dropdownTripItems = document.querySelectorAll<HTMLButtonElement>('.trips-dropdown-item');

  const onTriggerClick = (e: MouseEvent) => {
    e.stopPropagation();
    toggleTripsDropdown();
  };

  const onClearClick = (e: MouseEvent) => {
    e.stopPropagation();
    callbacks.onSelectTrip(null);
    closeTripsDropdown();
  };

  const onItemClick = (item: HTMLButtonElement) => (e: MouseEvent) => {
    e.stopPropagation();
    const tid = item.dataset.tripId;
    if (!tid) return;
    if (callbacks.getActiveTripId() === tid) {
      callbacks.onSelectTrip(null);
    } else {
      callbacks.onSelectTrip(tid);
    }
    closeTripsDropdown();
  };

  const onDocClick = (e: MouseEvent) => {
    if (dropdownContainer && !dropdownContainer.contains(e.target as Node)) {
      closeTripsDropdown();
    }
  };

  const onDocKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeTripsDropdown();
    }
  };

  if (dropdownTrigger) {
    dropdownTrigger.addEventListener('click', onTriggerClick);
  }

  if (dropdownClear) {
    dropdownClear.addEventListener('click', onClearClick);
  }

  const itemCleanups: Array<() => void> = [];
  dropdownTripItems.forEach((item) => {
    const handler = onItemClick(item);
    item.addEventListener('click', handler);
    itemCleanups.push(() => item.removeEventListener('click', handler));
  });

  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onDocKeydown);

  return () => {
    if (dropdownTrigger) {
      dropdownTrigger.removeEventListener('click', onTriggerClick);
    }
    if (dropdownClear) {
      dropdownClear.removeEventListener('click', onClearClick);
    }
    itemCleanups.forEach((c) => c());
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onDocKeydown);
  };
}
