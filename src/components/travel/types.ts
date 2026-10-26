import type * as maplibregl from 'maplibre-gl';

export interface PlaceTripInfo {
  tripId: string;
  tripName: string;
  color: string;
  mode?: string;
  stopIndices: number[];
  totalStops: number;
  summary?: string;
}

export interface PlaceData {
  id: string;
  name: string;
  type: 'city' | 'park' | 'landmark';
  lat: number;
  lng: number;
  country: string;
  blurb?: string;
  photo?: string;
  link?: string;
  trips?: PlaceTripInfo[];
}

export interface TripStop {
  name: string;
  placeId?: string;
  lat: number;
  lng: number;
}

export interface TripData {
  id: string;
  name: string;
  summary?: string;
  date?: string;
  color: string;
  mode?: string;
  stops: TripStop[];
  distanceMiles: number;
  durationHours: number;
  geometry: {
    type: 'LineString';
    coordinates: [number, number][];
  };
}

export interface MarkerRecord {
  id: string;
  name: string;
  marker: maplibregl.Marker;
  popup: maplibregl.Popup;
  element: HTMLElement;
  type: string;
  lat: number;
  lng: number;
  place: PlaceData;
}

export type FilterCategory = 'all' | 'park' | 'city' | 'landmark';

export interface RouteSvgOverlayElements {
  routeSvg: SVGSVGElement | null;
  routeGlowPath: SVGPathElement | null;
  routeCasingPath: SVGPathElement | null;
  routeLinePath: SVGPathElement | null;
  routeLeadGroup: SVGGElement | null;
  routeLeadDot: SVGCircleElement | null;
  routeLeadHalo: SVGCircleElement | null;
}
