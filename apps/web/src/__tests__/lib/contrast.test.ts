import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ACCENT_PRESETS } from '../../lib/theme';

/**
 * WCAG 2.x AA contrast checks computed from the REAL tokens in index.css
 * (parsed, not copied), for every accent preset in both modes.
 */

const css = readFileSync(resolve(__dirname, '../../index.css'), 'utf8');

function blockVars(selector: ':root' | '.dark'): Record<string, string> {
  const vars: Record<string, string> = {};
  const re = new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`, 'g');
  for (const m of css.matchAll(re)) {
    for (const d of m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[d[1]] = d[2].trim();
  }
  return vars;
}

const lightVars = blockVars(':root');
const darkVars = { ...lightVars, ...blockVars('.dark') };

type RGB = [number, number, number];

function oklchToRgb(L: number, C: number, hDeg: number): RGB {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  // Clamp to sRGB (matches how browsers gamut-map out-of-range accents closely enough).
  return lin.map((v) => Math.min(1, Math.max(0, v))) as RGB;
}

function resolveColor(value: string, vars: Record<string, string>, hue: number): RGB {
  let v = value.trim();
  v = v.replace(/var\((--[\w-]+)\)/g, (_, name: string) => {
    if (name === '--accent-hue') return String(hue);
    const ref = vars[name];
    if (ref === undefined) throw new Error(`unresolved ${name}`);
    return ref;
  });
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }) as RGB;
  }
  const ok = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(v);
  if (ok) return oklchToRgb(Number(ok[1]) / 100, Number(ok[2]), Number(ok[3]));
  // Nested var() inside oklch() is already substituted above; anything else is a bug.
  // A var() that resolved to another var() needs another pass:
  if (v !== value.trim() && /var\(/.test(v)) return resolveColor(v, vars, hue);
  throw new Error(`cannot parse color: ${value} -> ${v}`);
}

function luminance([r, g, b]: RGB): number {
  // Inputs are linear-light already.
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function tok(vars: Record<string, string>, name: string, hue: number): RGB {
  const raw = vars[name];
  if (!raw) throw new Error(`missing token ${name}`);
  return resolveColor(raw, vars, hue);
}

const AA_TEXT = 4.5;

describe('contrast helper sanity', () => {
  it('black on white is 21:1', () => {
    expect(contrast([0, 0, 0], [1, 1, 1])).toBeCloseTo(21, 1);
  });
  it('same colour is 1:1', () => {
    expect(contrast([0.2, 0.2, 0.2], [0.2, 0.2, 0.2])).toBeCloseTo(1, 5);
  });
});

describe.each([
  ['light', lightVars],
  ['dark', darkVars],
] as const)('%s mode design tokens meet WCAG AA', (_mode, vars) => {
  it.each(ACCENT_PRESETS.map((a) => [a.id, a.hue] as const))('accent %s', (_id, hue) => {
    const t = (n: string) => tok(vars, n, hue);
    const pairs: [string, string, string][] = [
      ['--nyx-text', '--nyx-bg', 'text on page'],
      ['--nyx-text', '--nyx-surface', 'text on surface'],
      ['--nyx-text-muted', '--nyx-bg', 'muted on page'],
      ['--nyx-text-muted', '--nyx-surface', 'muted on surface'],
      ['--nyx-accent-fg', '--nyx-accent', 'button label on accent'],
      ['--nyx-accent-text', '--nyx-bg', 'accent text on page'],
      ['--nyx-accent-text', '--nyx-surface', 'accent text on surface'],
      ['--color-blue-700', '--nyx-surface', 'hover/pressed accent as text-white bg'],
    ];
    for (const [fg, bg, label] of pairs) {
      // Hover/pressed shade is a button fill with white text, not text on surface.
      const ratio =
        fg === '--color-blue-700'
          ? contrast([1, 1, 1], t(fg))
          : contrast(t(fg), t(bg));
      expect(ratio, `${label} (${fg} on ${bg}) = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });
});

describe('dark-mode slate remap (used by existing utilities)', () => {
  it('text-slate-500 stays readable on dark surfaces', () => {
    const fg = tok(darkVars, '--color-slate-500', 287);
    for (const bg of ['--color-slate-50', '--color-white'] as const) {
      expect(contrast(fg, tok(darkVars, bg, 287))).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });
});
