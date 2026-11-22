export interface TimelineTile {
  id?: number;
  title: string;
  artist: string;
  primaryArtist: string;
  artistKeys: string[];
  albumKey: string;
  image: string;
  rank: number;
  streams: number;
  col: number;
  row: number;
  span: 1 | 2 | 3;
}

export interface TimelineYear {
  year: number;
  isCurrentYear: boolean;
  totalStreams: number;
  totalMinutes: number;
  totalHours: number;
  uniqueAlbums: number;
  volumeRatio: number;
  topGenres: string[];
  cols: number;
  rows: number;
  tiles: TimelineTile[];
  eraNote?: string;
}

export interface TimelinePayload {
  username: string;
  years: TimelineYear[];
  maxHours: number;
  totalYears: number;
}
