export const COLOR_MAP: Record<string, string> = {
  amber: '#f59e0b',
  yellow: '#eab308',
  gold: '#eab308',
  orange: '#f97316',
  coral: '#fb7185',
  scarlet: '#e11d48',
  red: '#ef4444',
  crimson: '#dc2626',
  rose: '#f43f5e',
  pink: '#ec4899',
  fuchsia: '#d946ef',
  fuschia: '#d946ef',
  purple: '#8b5cf6',
  violet: '#7c3aed',
  lavender: '#a78bfa',
  indigo: '#6366f1',
  blue: '#3b82f6',
  sky: '#0284c7',
  cyan: '#06b6d4',
  teal: '#14b8a6',
  emerald: '#10b981',
  green: '#10b981',
  lime: '#84cc16',
  brown: '#b45309',
  gray: '#94a3b8',
  grey: '#94a3b8'
};

export function resolveTripColorHex(colorName?: string): string {
  if (!colorName) return '#f59e0b';
  const trimmed = colorName.trim();
  if (trimmed.startsWith('#')) {
    const raw = trimmed.slice(1);
    return (
      '#' +
      (raw.length === 3
        ? raw
            .split('')
            .map((c) => c + c)
            .join('')
        : raw)
    );
  }
  return COLOR_MAP[trimmed.toLowerCase()] || '#f59e0b';
}

export interface TripTheme {
  line: string;
  glow: string;
  text: string;
  bg: string;
  border: string;
}

export function getTripTheme(colorName?: string): TripTheme {
  const hex = resolveTripColorHex(colorName);
  const r = parseInt(hex.slice(1, 3), 16) || 245;
  const g = parseInt(hex.slice(3, 5), 16) || 158;
  const b = parseInt(hex.slice(5, 7), 16) || 11;
  return {
    line: hex,
    glow: `rgba(${r}, ${g}, ${b}, 0.45)`,
    text: hex,
    bg: `rgba(${r}, ${g}, ${b}, 0.14)`,
    border: `rgba(${r}, ${g}, ${b}, 0.35)`
  };
}
