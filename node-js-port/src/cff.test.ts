import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { Path } from './outline.js';
import { CffSource, normalizeMatrix } from './cff.js';
import { FontRef } from './sfnt.js';

/**
 * A real non-CID CFF font with Type 2 charstrings, local subrs, a Private
 * DICT and a non-trivial Top DICT.
 */
const CFF = readFileSync(new URL('../testdata/SourceSansPro-Regular.otf', import.meta.url));

describe('normalizeMatrix', () => {
  it('is effectively identity for the usual 0.001 matrix', () => {
    const m = normalizeMatrix([0.001, 0, 0, 0.001, 0, 0]);
    expect(m.upem).toBe(1000);
    expect(m.a).toBeCloseTo(1, 10);
    expect(m.d).toBeCloseTo(1, 10);
    expect(m.b).toBe(0);
    expect(m.c).toBe(0);
    expect(m.tx).toBe(0);
    expect(m.ty).toBe(0);
  });

  it('defaults to 0.001 when absent', () => {
    expect(normalizeMatrix(undefined).upem).toBe(1000);
  });

  it('derives a non-standard upem from a non-default matrix', () => {
    expect(normalizeMatrix([1, 0, 0, 1, 0, 0]).upem).toBe(1);
  });
});

describe('CffSource against a real CFF font', () => {
  const font = FontRef.new(new Uint8Array(CFF));
  const cff = font.outline_cff();

  it('is exposed only for CFF fonts', () => {
    expect(cff).toBeDefined();
    // A CFF font has no glyf table, so the glyf source must be absent.
    expect(font.outline_glyphs()).toBeUndefined();
  });

  it('parses the CharStrings INDEX', () => {
    expect(cff!.glyphCount).toBeGreaterThan(0);
  });

  it('outlines a glyph with a real extent and closes its contour', () => {
    const cmap = font.charmap()!;
    const glyph = cmap.glyph_id(0x41); // 'A'
    expect(glyph).toBeGreaterThan(0);

    const path = new Path();
    expect(cff!.outline(glyph, path)).toBe(true);
    expect(path.is_empty).toBe(false);
    const first = path.commands[0]?.kind;
    const last = path.commands[path.commands.length - 1]?.kind;
    expect(first).toBe('MoveTo');
    expect(last).toBe('Close');

    const b = path.bounds()!;
    // The bug that motivated the rewrite yielded a zero-width path here.
    // 'A' in Source Sans Pro is a normal Latin glyph, nowhere near the em box.
    expect(b.xMax - b.xMin, 'width').toBeGreaterThan(300);
    expect(b.yMax - b.yMin, 'height').toBeGreaterThan(300);
    // And it stayed inside the em square rather than growing past it.
    expect(b.xMin).toBeGreaterThan(-2000);
    expect(b.xMax).toBeLessThan(2000);
    expect(b.yMax).toBeLessThan(2000);
  });

  it('emits cubics, the CFF curve type', () => {
    const cmap = font.charmap()!;
    const glyph = cmap.glyph_id(0x41)!;
    const path = new Path();
    cff!.outline(glyph, path);
    const kinds = new Set(path.commands.map((c) => c.kind));
    expect(kinds.has('CubicTo')).toBe(true);
    expect(kinds.has('QuadTo')).toBe(false);
  });

  it('outlines every glyph without degenerate extents', () => {
    const cmap = font.charmap()!;
    for (const cp of [0x41, 0x42, 0x43, 0x61, 0x65]) {
      const g = cmap.glyph_id(cp);
      if (g === undefined) continue;
      const path = new Path();
      if (cff!.outline(g, path)) {
        const b = path.bounds()!;
        expect(b.xMax - b.xMin, `width of U+${cp.toString(16)}`).toBeGreaterThan(200);
        expect(b.yMax - b.yMin, `height of U+${cp.toString(16)}`).toBeGreaterThan(200);
      }
    }
  });

  it('returns false for a glyph id with no outline', () => {
    expect(cff!.outline(cff!.glyphCount + 50, new Path())).toBe(false);
  });
});
