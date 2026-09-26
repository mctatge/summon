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

function readableAccent(color: string, ratio: number, backgrounds: string[], target = '#000000') {
  // Keep the chosen hue, adjusting its lightness for the current surfaces.
  for (let step = 0; step <= 100; step++) {
    const candidate = mix(color, target, step / 100);
    if (backgrounds.every(background => contrastRatio(candidate, background) >= ratio)) return candidate;
  }
  return target;
}

export function accentVariables(value?: string, dark = false): Record<`--${string}`, string> {
  const selected = normalizeAccentColor(value);
  const surfaces = dark ? ['#191b1a', '#242725', '#202321', '#2d312e'] : ['#ffffff', '#eaeae8', '#f5f5f3'];
  const target = dark ? '#ffffff' : '#000000';
  const preferred = dark && selected === DEFAULT_ACCENT ? '#edf0eb' : selected;
  const visible = dark ? readableAccent(preferred, 3, surfaces, target) : selected;
  const soft = dark
    ? selected === DEFAULT_ACCENT ? '#303631' : mix(visible, '#242725', .88)
    : mix(selected, '#ffffff', .93);
  const backgrounds = [...surfaces, soft];
  // Dark accents, including the default graphite, still need a visible button.
  const color = dark ? readableAccent(preferred, 3, backgrounds, target) : selected;
  const foreground = contrastRatio(color, '#ffffff') >= contrastRatio(color, '#000000') ? '#ffffff' : '#000000';
  return {
    '--accent': color,
    '--on-accent': foreground,
    '--accent-hover': mix(color, foreground === '#ffffff' ? '#000000' : '#ffffff', .12),
    '--accent-soft': soft,
    '--accent-ink': readableAccent(preferred, 4.5, backgrounds, target),
    '--accent-meter': readableAccent(preferred, 3, backgrounds, target),
    '--accent-edge': backgrounds.some(background => contrastRatio(color, background) < 3) ? readableAccent(preferred, 3, backgrounds, target) : 'transparent',
  };
}

/** Follow the system immediately and while this renderer remains mounted. */
export function followSystemAppearance(value: string | undefined, style: Pick<CSSStyleDeclaration, 'setProperty'>, preference: Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>) {
  const apply = () => {
    for (const [name, color] of Object.entries(accentVariables(value, preference.matches))) style.setProperty(name, color);
  };
  apply();
  preference.addEventListener('change', apply);
  return () => preference.removeEventListener('change', apply);
}
