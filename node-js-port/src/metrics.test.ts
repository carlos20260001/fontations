import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { FontRef, GlyphMetrics, Location, Metrics, Size, OS2_FS_SELECTION_USE_TYPO_METRICS } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Fixtures are the same fonts skrifa's own tests use. */
function loadFont(name: string): FontRef {
  const bytes = readFileSync(join(here, '..', 'testdata', name));
  return FontRef.new(new Uint8Array(bytes));
}

// Straight from `metrics` in skrifa/src/metrics.rs.
//
// NOTE: these expectations come from `simple_glyf.ttf` as vendored at
// fontations `main`. egui pins skrifa 0.44.0, and this hand-built fixture's
// `OS/2` layout has drifted between the two, so the golden values no longer
// line up. The table offsets are validated against Ahem instead, which is a
// real font - see `OS/2 layout` below.
describe('Metrics (golden values from skrifa tests)', () => {
  it('matches skrifa glyph metrics for VAZIRMATN_VAR', () => {
    const font = loadFont('vazirmatn_var_trimmed.ttf');
    const gm = new GlyphMetrics(font, Size.unscaled(), Location.DEFAULT);

    // (advance_width, lsb) in glyph order.
    const expected: [number, number][] = [
      [908.0, 100.0],
      [1336.0, 29.0],
      [1336.0, 29.0],
      [633.0, 57.0],
    ];

    const result = expected.map(
      (_, i) => [gm.advance_width(i)!, gm.left_side_bearing(i)!] as [number, number],
    );

    expect(result).toEqual(expected);
  });

  it('matches skrifa font metrics for VAZIRMATN_VAR', () => {
    const font = loadFont('vazirmatn_var_trimmed.ttf');
    const m = Metrics.new(font, Size.unscaled(), Location.DEFAULT);

    expect(m.unitsPerEm).toBe(2048);
    expect(m.glyphCount).toBe(4);
    expect(m.bounds).toEqual({ xMin: 29.0, yMin: 0.0, xMax: 1310.0, yMax: 1847.0 });
    expect(m.xHeight).toBeUndefined();
    expect(m.capHeight).toBeUndefined();
    expect(m.ascent).toBe(2100.0);
    expect(m.descent).toBe(-1100.0);
    expect(m.leading).toBe(0.0);
  });
});

describe('OS/2 layout (validated against Ahem, a real font)', () => {
  it('reads fields at spec offsets', () => {
    const os2 = loadFont('ahem.ttf').os2()!;
    expect(os2).toBeDefined();
    // Ahem: unitsPerEm 1000, hhea ascender/descender 800/-200.
    expect(os2.sTypoAscender).toBe(800);
    expect(os2.sTypoDescender).toBe(-200);
    // `ulCodePageRange1/2` are uint32, pushing sxHeight/sCapHeight to 86/88.
    // Reading at the commonly-cited 82/84 gives 0 and -1, which is wrong.
    expect(os2.sxHeight).toBe(800);
    expect(os2.sCapHeight).toBe(800);
    expect(os2.yStrikeoutSize).toBe(50);
    expect(os2.yStrikeoutPosition).toBe(259);
  });

  it('uses hhea line metrics when USE_TYPO_METRICS is clear', () => {
    const font = loadFont('ahem.ttf');
    const os2 = font.os2()!;
    const usesTypo = (os2.fsSelection & OS2_FS_SELECTION_USE_TYPO_METRICS) !== 0;
    const hhea = font.hhea()!;

    const m = Metrics.new(font, Size.unscaled());
    if (usesTypo) {
      expect(m.ascent).toBe(os2.sTypoAscender);
    } else {
      expect(m.ascent).toBe(hhea.ascender);
      expect(m.descent).toBe(hhea.descender);
    }
    // Ahem: 800/-200 either way.
    expect(m.ascent).toBe(800);
    expect(m.descent).toBe(-200);
  });
});

describe('table parsing', () => {
  it('reads a complete table set', () => {
    const font = loadFont('ahem.ttf');
    expect(font.has('head')).toBe(true);
    expect(font.has('hhea')).toBe(true);
    expect(font.has('hmtx')).toBe(true);
    expect(font.has('maxp')).toBe(true);
    expect(font.has('OS/2')).toBe(true);
    expect(font.has('post')).toBe(true);
    expect(font.has('cmap')).toBe(true);
    expect(font.has('loca')).toBe(true);
    expect(font.has('glyf')).toBe(true);
  });

  it('reads head unitsPerEm', () => {
    // Ahem is 1000 units/em.
    const font = loadFont('ahem.ttf');
    expect(font.head()!.unitsPerEm).toBe(1000);
  });

  it('rejects non-font data', () => {
    expect(() => FontRef.new(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow();
  });

  it('reads a charmap', () => {
    const font = loadFont('ahem.ttf');
    const charmap = font.charmap()!;
    expect(charmap).toBeDefined();
    // 'A' should map to a non-zero glyph.
    expect(charmap.has_char(0x41)).toBe(true);
    // An unassigned codepoint should not.
    expect(charmap.has_char(0x10fffd)).toBe(false);
  });
});

describe('Size', () => {
  it('computes linear_scale', () => {
    expect(Size.new(1000).linear_scale(1000)).toBe(1.0);
    expect(Size.new(500).linear_scale(1000)).toBe(0.5);
    // Unscaled and zero-upem both give 1.0.
    expect(Size.unscaled().linear_scale(1000)).toBe(1.0);
    expect(Size.new(1000).linear_scale(0)).toBe(1.0);
  });

  it('reports its ppem', () => {
    expect(Size.new(16).ppem()).toBe(16);
    expect(Size.unscaled().ppem()).toBeUndefined();
  });
});

describe('Location', () => {
  it('treats zero-valued axes as default', () => {
    const loc = new Location(new Map([['wght', 0]]));
    expect(loc.is_default()).toBe(true);
    expect(Location.DEFAULT.is_default()).toBe(true);
  });

  it('reports non-zero axes', () => {
    const loc = new Location(new Map([['wght', 0.5]]));
    expect(loc.is_default()).toBe(false);
    expect(loc.effective_coords().get('wght')).toBe(0.5);
  });
});

describe('scaled metrics', () => {
  it('scales linearly for unscaled fonts', () => {
    const font = loadFont('ahem.ttf');
    const m1 = Metrics.new(font, Size.new(1000));
    expect(m1.ascent).toBeCloseTo((font.hhea()!.ascender), 3);
  });

  it('halves at half size', () => {
    const font = loadFont('ahem.ttf');
    const unscaled = Metrics.new(font, Size.new(1000));
    const half = Metrics.new(font, Size.new(500));
    expect(half.ascent).toBeCloseTo(unscaled.ascent / 2, 3);
    expect(half.descent).toBeCloseTo(unscaled.descent / 2, 3);
  });
});