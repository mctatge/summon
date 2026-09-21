export const DEFAULT_ACCENT = '#141615';

/** Only opaque hex colors enter saved preferences or CSS custom properties. */
export function parseAccentColor(value) {
  if (typeof value !== 'string') return null;
  const hex = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(hex)) return hex;
  if (/^#[0-9a-f]{3}$/.test(hex)) return `#${[...hex.slice(1)].map(char => char + char).join('')}`;
  return null;
}

export const normalizeAccentColor = value => parseAccentColor(value) ?? DEFAULT_ACCENT;
