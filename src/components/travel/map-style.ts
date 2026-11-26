import type * as maplibregl from 'maplibre-gl';

export type MapTheme = 'light' | 'dark';

export type TravelStyleSpecification = Exclude<
  maplibregl.MapOptions['style'],
  string | undefined
>;

export interface TravelFeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    properties: Record<string, string | number>;
    geometry: { type: 'LineString'; coordinates: [number, number][] };
  }>;
}

export const ROUTE_SOURCE_ID = 'trip-route-source';

export const EMPTY_FEATURE_COLLECTION: TravelFeatureCollection = {
  type: 'FeatureCollection',
  features: []
};

interface MapPalette {
  land: string;
  urban: string;
  wood: string;
  park: string;
  sand: string;
  ice: string;
  hillshadeShadow: string;
  hillshadeHighlight: string;
  hillshadeAccent: string;
  water: string;
  waterLine: string;
  river: string;
  borderState: string;
  borderCountry: string;
  roadCase: string;
  roadFill: string;
  roadMinor: string;
  rail: string;
  building: string;
  buildingOutline: string;
  textCountry: string;
  textState: string;
  textCity: string;
  textTown: string;
  textHalo: string;
  routeCasing: string;
  sky: NonNullable<TravelStyleSpecification['sky']>;
}

const LIGHT_PALETTE: MapPalette = {
  land: '#efe4cb',
  urban: '#e3d8c0',
  wood: '#c3d6ae',
  park: '#bdd3a6',
  sand: '#e6d09f',
  ice: '#faf8f3',
  hillshadeShadow: '#6b6358',
  hillshadeHighlight: '#fffdf7',
  hillshadeAccent: '#57534e',
  water: '#8fbdd6',
  waterLine: '#5f93b3',
  river: '#6fa3c2',
  borderState: '#cbc3b4',
  borderCountry: '#9a9082',
  roadCase: '#d6cfc2',
  roadFill: '#fdfbf7',
  roadMinor: '#e5dfd2',
  rail: '#a8a29e',
  building: '#e6dfd2',
  buildingOutline: '#d4ccbc',
  textCountry: '#44403c',
  textState: '#665e56',
  textCity: '#292524',
  textTown: '#57534e',
  textHalo: 'rgba(248, 244, 236, 0.92)',
  routeCasing: 'rgba(255, 253, 248, 0.92)',
  sky: {
    'atmosphere-blend': 0
  }
};

const DARK_PALETTE: MapPalette = {
  land: '#2d2924',
  urban: '#2f2b26',
  wood: '#203528',
  park: '#1d3527',
  sand: '#2d2720',
  ice: '#333230',
  hillshadeShadow: '#0a0908',
  hillshadeHighlight: '#54504a',
  hillshadeAccent: '#141311',
  water: '#14232f',
  waterLine: '#2e4659',
  river: '#1e3547',
  borderState: '#34322e',
  borderCountry: '#4e4a44',
  roadCase: '#302e2a',
  roadFill: '#3d3a35',
  roadMinor: '#2c2a27',
  rail: '#44403c',
  building: '#2a2825',
  buildingOutline: '#383530',
  textCountry: '#a8a29e',
  textState: '#78716c',
  textCity: '#e7e5e4',
  textTown: '#a8a29e',
  textHalo: 'rgba(20, 19, 17, 0.92)',
  routeCasing: 'rgba(15, 14, 13, 0.9)',
  sky: {
    'atmosphere-blend': 0
  }
};

export function getEffectiveMapTheme(): MapTheme {
  if (typeof document !== 'undefined') {
    const explicit = document.documentElement.getAttribute('data-theme');
    if (explicit === 'dark' || explicit === 'light') {
      return explicit;
    }
  }
  if (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  ) {
    return 'dark';
  }
  return 'light';
}

export function observeMapThemeChanges(
  onChange: (theme: MapTheme) => void
): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return () => {};
  }

  let currentTheme = getEffectiveMapTheme();

  const handlePossibleChange = () => {
    const nextTheme = getEffectiveMapTheme();
    if (nextTheme !== currentTheme) {
      currentTheme = nextTheme;
      onChange(nextTheme);
    }
  };

  const observer = new MutationObserver(handlePossibleChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme']
  });

  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  mediaQuery.addEventListener('change', handlePossibleChange);

  return () => {
    observer.disconnect();
    mediaQuery.removeEventListener('change', handlePossibleChange);
  };
}

const cls = (...names: string[]): maplibregl.ExpressionSpecification => [
  'match',
  ['get', 'class'],
  names,
  true,
  false
];

const aboveGround: maplibregl.ExpressionSpecification = [
  '!=',
  ['get', 'brunnel'],
  'tunnel'
];

const ENGLISH_NAME_EXPR: maplibregl.ExpressionSpecification = [
  'coalesce',
  ['get', 'name:en'],
  ['get', 'name_en'],
  ['get', 'name:latin'],
  ['get', 'name']
];

export function getRouteCasingColor(theme: MapTheme): string {
  return theme === 'dark'
    ? DARK_PALETTE.routeCasing
    : LIGHT_PALETTE.routeCasing;
}

export function buildTravelMapStyle(
  theme: MapTheme,
  routeData: TravelFeatureCollection = EMPTY_FEATURE_COLLECTION
): TravelStyleSpecification {
  const C = theme === 'dark' ? DARK_PALETTE : LIGHT_PALETTE;
  const isDark = theme === 'dark';

  const haloPaint = {
    'text-halo-color': C.textHalo,
    'text-halo-width': 2.0,
    'text-halo-blur': 0.6
  };

  return {
    version: 8,
    state: {
      routeOpacity: { default: 1 }
    },
    projection: { type: 'globe' },
    sky: C.sky,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      omt: {
        type: 'vector',
        url: 'https://tiles.openfreemap.org/planet'
      },
      dem: {
        type: 'raster-dem',
        tiles: [
          'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png'
        ],
        encoding: 'terrarium',
        tileSize: 512,
        maxzoom: 11
      },
      [ROUTE_SOURCE_ID]: {
        type: 'geojson',
        data: routeData
      }
    },
    layers: [
      {
        id: 'land',
        type: 'background',
        paint: {
          'background-color': C.land
        }
      },
      {
        id: 'urban',
        type: 'fill',
        source: 'omt',
        'source-layer': 'landuse',
        minzoom: 5,
        filter: cls(
          'residential',
          'suburb',
          'neighbourhood',
          'commercial',
          'industrial',
          'retail'
        ),
        paint: {
          'fill-color': C.urban,
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0, 8, 0.7]
        }
      },
      {
        id: 'wood',
        type: 'fill',
        source: 'omt',
        'source-layer': 'landcover',
        minzoom: 4,
        filter: cls('wood', 'forest'),
        paint: {
          'fill-color': C.wood,
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 4, 0, 7, 0.7]
        }
      },
      {
        id: 'grass',
        type: 'fill',
        source: 'omt',
        'source-layer': 'landcover',
        minzoom: 5,
        filter: cls('grass', 'farmland', 'wetland'),
        paint: {
          'fill-color': C.park,
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0, 8, 0.45]
        }
      },
      {
        id: 'sand',
        type: 'fill',
        source: 'omt',
        'source-layer': 'landcover',
        minzoom: 4,
        filter: cls('sand'),
        paint: {
          'fill-color': C.sand,
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 4, 0, 7, 0.65]
        }
      },
      {
        id: 'ice',
        type: 'fill',
        source: 'omt',
        'source-layer': 'landcover',
        minzoom: 2,
        filter: cls('ice'),
        paint: {
          'fill-color': C.ice,
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 2, 0.3, 6, 0.8]
        }
      },
      {
        id: 'park',
        type: 'fill',
        source: 'omt',
        'source-layer': 'park',
        minzoom: 4,
        paint: {
          'fill-color': C.park,
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 4, 0.2, 8, 0.72]
        }
      },
      // Hillshade sits below water polygons so ocean bathymetry tiles are masked cleanly
      {
        id: 'relief',
        type: 'hillshade',
        source: 'dem',
        minzoom: 1,
        paint: {
          'hillshade-illumination-direction': 315,
          'hillshade-shadow-color': C.hillshadeShadow,
          'hillshade-highlight-color': C.hillshadeHighlight,
          'hillshade-accent-color': C.hillshadeAccent,
          'hillshade-exaggeration': [
            'interpolate',
            ['linear'],
            ['zoom'],
            1,
            isDark ? 0.28 : 0.24,
            3,
            isDark ? 0.38 : 0.34,
            6,
            isDark ? 0.35 : 0.32,
            10,
            isDark ? 0.26 : 0.24,
            14,
            0.16
          ]
        }
      },
      {
        id: 'water',
        type: 'fill',
        source: 'omt',
        'source-layer': 'water',
        paint: {
          'fill-color': C.water
        }
      },
      {
        id: 'shore',
        type: 'line',
        source: 'omt',
        'source-layer': 'water',
        paint: {
          'line-color': C.waterLine,
          'line-opacity': 0.72,
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            1,
            0.5,
            6,
            0.9,
            14,
            1.2
          ]
        }
      },
      {
        id: 'river',
        type: 'line',
        source: 'omt',
        'source-layer': 'waterway',
        minzoom: 4,
        filter: [
          'all',
          aboveGround,
          ['any', ['!=', ['get', 'class'], 'river'], ['<', ['zoom'], 11]]
        ],
        paint: {
          'line-color': C.river,
          'line-opacity': 0.8,
          'line-width': [
            'interpolate',
            ['exponential', 1.5],
            ['zoom'],
            4,
            0.5,
            8,
            1.0,
            14,
            2.2
          ]
        }
      },
      {
        id: 'border-state',
        type: 'line',
        source: 'omt',
        'source-layer': 'boundary',
        minzoom: 2.2,
        filter: [
          'all',
          ['==', ['get', 'admin_level'], 4],
          ['!=', ['get', 'maritime'], 1]
        ],
        paint: {
          'line-color': C.borderState,
          'line-opacity': [
            'interpolate',
            ['linear'],
            ['zoom'],
            2.2,
            0.35,
            5,
            0.75
          ],
          'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.5, 8, 1.0],
          'line-dasharray': [3, 2]
        }
      },
      {
        id: 'border-country',
        type: 'line',
        source: 'omt',
        'source-layer': 'boundary',
        filter: [
          'all',
          ['==', ['get', 'admin_level'], 2],
          ['!=', ['get', 'maritime'], 1]
        ],
        paint: {
          'line-color': C.borderCountry,
          'line-opacity': 0.85,
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            1,
            0.6,
            4,
            1.0,
            10,
            1.6
          ]
        }
      },
      {
        id: 'rail',
        type: 'line',
        source: 'omt',
        'source-layer': 'transportation',
        minzoom: 10,
        filter: ['all', cls('rail', 'transit'), aboveGround],
        paint: {
          'line-color': C.rail,
          'line-opacity': 0.55,
          'line-width': 1,
          'line-dasharray': [4, 3]
        }
      },
      {
        id: 'road-minor',
        type: 'line',
        source: 'omt',
        'source-layer': 'transportation',
        minzoom: 12,
        filter: ['all', cls('minor', 'service'), aboveGround],
        layout: {
          'line-cap': 'round',
          'line-join': 'round'
        },
        paint: {
          'line-color': C.roadMinor,
          'line-opacity': [
            'interpolate',
            ['linear'],
            ['zoom'],
            12,
            0.35,
            15,
            0.85
          ],
          'line-width': [
            'interpolate',
            ['exponential', 1.6],
            ['zoom'],
            12,
            0.5,
            15,
            1.6,
            18,
            6
          ]
        }
      },
      {
        id: 'road-major-case',
        type: 'line',
        source: 'omt',
        'source-layer': 'transportation',
        minzoom: 5.5,
        filter: [
          'all',
          cls('motorway', 'trunk', 'primary', 'secondary', 'tertiary'),
          aboveGround
        ],
        layout: {
          'line-cap': 'round',
          'line-join': 'round'
        },
        paint: {
          'line-color': C.roadCase,
          'line-opacity': [
            'interpolate',
            ['linear'],
            ['zoom'],
            5.5,
            0.3,
            9,
            0.8
          ],
          'line-width': [
            'interpolate',
            ['exponential', 1.6],
            ['zoom'],
            5.5,
            0.6,
            10,
            2.2,
            14,
            5.5,
            18,
            14
          ]
        }
      },
      {
        id: 'road-major',
        type: 'line',
        source: 'omt',
        'source-layer': 'transportation',
        minzoom: 8.5,
        filter: [
          'all',
          cls('motorway', 'trunk', 'primary', 'secondary', 'tertiary'),
          aboveGround
        ],
        layout: {
          'line-cap': 'round',
          'line-join': 'round'
        },
        paint: {
          'line-color': C.roadFill,
          'line-opacity': [
            'interpolate',
            ['linear'],
            ['zoom'],
            8.5,
            0,
            10,
            0.95
          ],
          'line-width': [
            'interpolate',
            ['exponential', 1.6],
            ['zoom'],
            8.5,
            0.4,
            10,
            1.2,
            14,
            3.5,
            18,
            10.5
          ]
        }
      },
      {
        id: 'building',
        type: 'fill',
        source: 'omt',
        'source-layer': 'building',
        minzoom: 14,
        paint: {
          'fill-color': C.building,
          'fill-outline-color': C.buildingOutline,
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, 0.85]
        }
      },
      {
        id: 'village-names',
        type: 'symbol',
        source: 'omt',
        'source-layer': 'place',
        minzoom: 9,
        filter: cls('village', 'suburb', 'quarter', 'hamlet', 'neighbourhood'),
        layout: {
          'text-field': ENGLISH_NAME_EXPR,
          'text-font': ['Noto Sans Italic'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 9, 10, 16, 13],
          'text-max-width': 8,
          'text-padding': 4,
          'text-pitch-alignment': 'map',
          'text-rotation-alignment': 'map',
          'symbol-sort-key': ['coalesce', ['get', 'rank'], 99]
        },
        paint: {
          'text-color': C.textTown,
          'text-opacity': [
            'interpolate',
            ['linear'],
            ['zoom'],
            9,
            0,
            9.8,
            0.85
          ],
          ...haloPaint
        }
      },
      {
        id: 'town-names',
        type: 'symbol',
        source: 'omt',
        'source-layer': 'place',
        minzoom: 6.5,
        filter: cls('town'),
        layout: {
          'text-field': ENGLISH_NAME_EXPR,
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 6.5, 10, 13, 13],
          'text-max-width': 8,
          'text-padding': 4,
          'text-pitch-alignment': 'map',
          'text-rotation-alignment': 'map',
          'symbol-sort-key': ['coalesce', ['get', 'rank'], 99]
        },
        paint: {
          'text-color': C.textTown,
          'text-opacity': [
            'interpolate',
            ['linear'],
            ['zoom'],
            6.5,
            0,
            7.2,
            0.9
          ],
          ...haloPaint
        }
      },
      {
        id: 'state-names',
        type: 'symbol',
        source: 'omt',
        'source-layer': 'place',
        minzoom: 3.2,
        maxzoom: 8.5,
        filter: cls('state', 'province'),
        layout: {
          'text-field': ENGLISH_NAME_EXPR,
          'text-font': ['Noto Sans Italic'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 3.2, 9.5, 8, 12.5],
          'text-transform': 'uppercase',
          'text-letter-spacing': 0.12,
          'text-max-width': 8,
          'text-padding': 5,
          'text-pitch-alignment': 'map',
          'text-rotation-alignment': 'map',
          'symbol-sort-key': ['coalesce', ['get', 'rank'], 99]
        },
        paint: {
          'text-color': C.textState,
          'text-opacity': [
            'interpolate',
            ['linear'],
            ['zoom'],
            3.2,
            0,
            4.0,
            0.78,
            7.5,
            0.78,
            8.5,
            0
          ],
          ...haloPaint
        }
      },
      {
        id: 'city-names',
        type: 'symbol',
        source: 'omt',
        'source-layer': 'place',
        minzoom: 3.2,
        filter: cls('city'),
        layout: {
          'text-field': ENGLISH_NAME_EXPR,
          'text-font': ['Noto Sans Regular'],
          'text-size': [
            'interpolate',
            ['linear'],
            ['zoom'],
            3.2,
            ['match', ['get', 'capital'], 2, 11.5, 10],
            10,
            ['match', ['get', 'capital'], 2, 15.5, 13.5],
            14,
            ['match', ['get', 'capital'], 2, 17, 15.5]
          ],
          'text-max-width': 8,
          'text-padding': 4,
          'text-pitch-alignment': 'map',
          'text-rotation-alignment': 'map',
          'symbol-sort-key': [
            '-',
            ['coalesce', ['get', 'rank'], 99],
            ['match', ['get', 'capital'], 2, 20, 0]
          ]
        },
        paint: {
          'text-color': C.textCity,
          'text-opacity': [
            'interpolate',
            ['linear'],
            ['zoom'],
            3.2,
            0,
            4.0,
            0.94
          ],
          ...haloPaint
        }
      },
      {
        id: 'country-names',
        type: 'symbol',
        source: 'omt',
        'source-layer': 'place',
        minzoom: 1.4,
        maxzoom: 6.2,
        filter: cls('country'),
        layout: {
          'text-field': ENGLISH_NAME_EXPR,
          'text-font': ['Noto Sans Regular'],
          'text-size': [
            'interpolate',
            ['linear'],
            ['zoom'],
            1.4,
            9.5,
            4,
            12,
            6,
            14
          ],
          'text-transform': 'uppercase',
          'text-letter-spacing': 0.14,
          'text-max-width': 8,
          'text-padding': 6,
          'text-pitch-alignment': 'map',
          'text-rotation-alignment': 'map',
          'symbol-sort-key': ['coalesce', ['get', 'rank'], 99]
        },
        paint: {
          'text-color': C.textCountry,
          'text-opacity': [
            'interpolate',
            ['linear'],
            ['zoom'],
            1.4,
            0.78,
            5.0,
            0.78,
            6.2,
            0
          ],
          ...haloPaint
        }
      },
      // WebGL draped trip route layers
      {
        id: 'trip-route-glow',
        type: 'line',
        source: ROUTE_SOURCE_ID,
        layout: {
          'line-cap': 'round',
          'line-join': 'round'
        },
        paint: {
          'line-color': ['coalesce', ['get', 'color'], '#f59e0b'],
          'line-opacity': [
            '*',
            0.42,
            ['coalesce', ['to-number', ['global-state', 'routeOpacity']], 1]
          ],
          'line-opacity-transition': { duration: 0 },
          'line-blur': 6,
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            2,
            6,
            4,
            7.5,
            12,
            15
          ]
        }
      },
      {
        id: 'trip-route-casing',
        type: 'line',
        source: ROUTE_SOURCE_ID,
        layout: {
          'line-cap': 'round',
          'line-join': 'round'
        },
        paint: {
          'line-color': C.routeCasing,
          'line-opacity': [
            '*',
            0.9,
            ['coalesce', ['to-number', ['global-state', 'routeOpacity']], 1]
          ],
          'line-opacity-transition': { duration: 0 },
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            2,
            4.2,
            4,
            5.3,
            12,
            8.5
          ]
        }
      },
      {
        id: 'trip-route-line-solid',
        type: 'line',
        source: ROUTE_SOURCE_ID,
        filter: ['!=', ['get', 'mode'], 'flight'],
        layout: {
          'line-cap': 'round',
          'line-join': 'round'
        },
        paint: {
          'line-color': ['coalesce', ['get', 'color'], '#f59e0b'],
          'line-opacity': [
            'coalesce',
            ['to-number', ['global-state', 'routeOpacity']],
            1
          ],
          'line-opacity-transition': { duration: 0 },
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            2,
            2.2,
            4,
            2.8,
            12,
            6
          ]
        }
      },
      {
        id: 'trip-route-line-dashed',
        type: 'line',
        source: ROUTE_SOURCE_ID,
        filter: ['==', ['get', 'mode'], 'flight'],
        layout: {
          'line-cap': 'butt',
          'line-join': 'round'
        },
        paint: {
          'line-color': ['coalesce', ['get', 'color'], '#f59e0b'],
          'line-opacity': [
            'coalesce',
            ['to-number', ['global-state', 'routeOpacity']],
            1
          ],
          'line-opacity-transition': { duration: 0 },
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            2,
            2.2,
            4,
            2.8,
            12,
            6
          ],
          'line-dasharray': [2.2, 1.6]
        }
      }
    ]
  };
}
