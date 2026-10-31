import type { FilterCategory } from './types';

export function updateDirectoryList(activeFilter: FilterCategory): void {
  const searchInput = document.getElementById(
    'places-search-input'
  ) as HTMLInputElement | null;
  const clearBtn = document.getElementById('places-search-clear');
  const query = (searchInput?.value || '').trim().toLowerCase();

  if (clearBtn) {
    clearBtn.style.display = query.length > 0 ? 'inline-flex' : 'none';
  }

  let totalVisibleCount = 0;
  const groups = document.querySelectorAll<HTMLElement>(
    '.places-group[data-group-type]'
  );

  groups.forEach((group) => {
    const groupType = group.dataset.groupType || '';
    const categoryMatchesGroup =
      activeFilter === 'all' || groupType === activeFilter;
    let groupVisibleCount = 0;

    const cards = group.querySelectorAll<HTMLElement>('.place-card');
    cards.forEach((card) => {
      const searchStr =
        card.dataset.search || (card.dataset.name || '').toLowerCase();
      const matchesSearch = !query || searchStr.includes(query);
      const visible = categoryMatchesGroup && matchesSearch;
      card.style.display = visible ? '' : 'none';
      if (visible) {
        groupVisibleCount++;
        totalVisibleCount++;
      }
    });

    group.style.display = groupVisibleCount > 0 ? '' : 'none';
    const countBadge = group.querySelector<HTMLElement>('[data-group-count]');
    if (countBadge) {
      countBadge.textContent = String(groupVisibleCount);
    }
  });

  const summaryCountEl = document.getElementById('summary-count');
  if (summaryCountEl) {
    summaryCountEl.textContent = `(${totalVisibleCount})`;
  }

  const emptyStateEl = document.getElementById('places-empty-state');
  if (emptyStateEl) {
    emptyStateEl.style.display = totalVisibleCount === 0 ? 'block' : 'none';
  }
}

export function setupPlacesDirectory(callbacks: {
  getActiveFilter: () => FilterCategory;
  onSelectPlace: (id: string, lat: number, lng: number, type: string) => void;
}): () => void {
  const placesDetails =
    document.querySelector<HTMLDetailsElement>('.places-details');
  const searchBar = document.querySelector<HTMLElement>('.places-search-bar');
  const searchInput = document.getElementById(
    'places-search-input'
  ) as HTMLInputElement | null;
  const searchClear = document.getElementById('places-search-clear');
  const placeCards = document.querySelectorAll<HTMLElement>('.place-card');

  const onDetailsToggle = () => {
    if (
      placesDetails &&
      !placesDetails.open &&
      searchInput &&
      searchInput.value
    ) {
      searchInput.value = '';
      updateDirectoryList(callbacks.getActiveFilter());
    }
  };

  const onStopPropagation = (e: Event) => {
    e.stopPropagation();
  };

  const onSearchKey = (e: KeyboardEvent) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.stopPropagation();
    }
  };

  const onSearchInput = () => {
    updateDirectoryList(callbacks.getActiveFilter());
  };

  const onSearchClear = (e: MouseEvent) => {
    e.stopPropagation();
    if (searchInput) {
      searchInput.value = '';
      updateDirectoryList(callbacks.getActiveFilter());
      searchInput.focus();
    }
  };

  if (placesDetails) {
    placesDetails.addEventListener('toggle', onDetailsToggle);
  }
  if (searchBar) {
    searchBar.addEventListener('click', onStopPropagation);
  }
  if (searchInput) {
    searchInput.addEventListener('click', onStopPropagation);
    searchInput.addEventListener('keydown', onSearchKey);
    searchInput.addEventListener('keyup', onSearchKey);
    searchInput.addEventListener('input', onSearchInput);
  }
  if (searchClear) {
    searchClear.addEventListener('click', onSearchClear);
  }

  const cardCleanups: Array<() => void> = [];
  placeCards.forEach((card) => {
    const handleSelect = () => {
      const id = card.dataset.id || '';
      const lat = parseFloat(card.dataset.lat || '0');
      const lng = parseFloat(card.dataset.lng || '0');
      const type = card.dataset.type || 'city';
      if (lat && lng && (lat !== 0 || lng !== 0)) {
        callbacks.onSelectPlace(id, lat, lng, type);
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleSelect();
      }
    };

    card.addEventListener('click', handleSelect);
    card.addEventListener('keydown', onKeyDown);
    cardCleanups.push(() => {
      card.removeEventListener('click', handleSelect);
      card.removeEventListener('keydown', onKeyDown);
    });
  });

  return () => {
    if (placesDetails) {
      placesDetails.removeEventListener('toggle', onDetailsToggle);
    }
    if (searchBar) {
      searchBar.removeEventListener('click', onStopPropagation);
    }
    if (searchInput) {
      searchInput.removeEventListener('click', onStopPropagation);
      searchInput.removeEventListener('keydown', onSearchKey);
      searchInput.removeEventListener('keyup', onSearchKey);
      searchInput.removeEventListener('input', onSearchInput);
    }
    if (searchClear) {
      searchClear.removeEventListener('click', onSearchClear);
    }
    cardCleanups.forEach((cleanup) => cleanup());
  };
}
