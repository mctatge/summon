import { DEFAULT_ACCENT, normalizeAccentColor, parseAccentColor } from '../core/appearance.mjs';

export { DEFAULT_ACCENT, normalizeAccentColor, parseAccentColor };

export const ACCENT_PRESETS = [
  { name: 'Black', color: DEFAULT_ACCENT },
  { name: 'Forest', color: '#32664c' },
  { name: 'Blue', color: '#345db3' },
  { name: 'Plum', color: '#72549a' },
  { name: 'Terracotta', color: '#a75337' },
] as const;

type RGB = [number, number, number];
const rgb = (color: string): RGB => [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16)) as RGB;
const hex = (channels: RGB) => `#${channels.map(value => Math.round(value).toString(16).padStart(2, '0')).join('')}`;
const mix = (color: string, target: string, amount: number) => {
  const destination = rgb(target);
  return hex(rgb(color).map((channel, index) => channel + (destination[index] - channel) * amount) as RGB);
};
const luminance = (color: string) => rgb(color).reduce((total, channel, index) => {
  const value = channel / 255;
  return total + (value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][index];
}, 0);
export function contrastRatio(first: string, second: string) {
  const a = luminance(normalizeAccentColor(first)), b = luminance(normalizeAccentColor(second));
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

function readableAccent(color: string, ratio: number, backgrounds: string[]) {
  // Preserve the selected hue while darkening text/meter roles on pale surfaces.
  for (let step = 0; step <= 100; step++) {
    const candidate = mix(color, '#000000', step / 100);
    if (backgrounds.every(background => contrastRatio(candidate, background) >= ratio)) return candidate;
  }
  return '#000000';
}

export function accentVariables(value?: string): Record<`--${string}`, string> {
  const color = normalizeAccentColor(value);
  const foreground = contrastRatio(color, '#ffffff') >= contrastRatio(color, '#000000') ? '#ffffff' : '#000000';
  const soft = mix(color, '#ffffff', .93);
  const backgrounds = ['#ffffff', '#e9e9e6', soft];
  return {
    '--accent': color,
    '--on-accent': foreground,
    '--accent-hover': mix(color, foreground === '#ffffff' ? '#000000' : '#ffffff', .12),
    '--accent-soft': soft,
    '--accent-ink': readableAccent(color, 4.5, backgrounds),
    '--accent-meter': readableAccent(color, 3, backgrounds),
    '--accent-edge': contrastRatio(color, '#ffffff') < 3 ? readableAccent(color, 3, backgrounds) : 'transparent',
  };
}
