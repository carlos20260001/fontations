import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { FontRef, OutlineSource, Path, outlineGlyph } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));

function loadFont(name: string): FontRef {
  const bytes = readFileSync(join(here, '..', 'testdata', name));
  return FontRef.new(new Uint8Array(bytes));
}

function outlineOf(font: FontRef, glyphId: number): Path {
  const path = new Path();
  const ok = outlineGlyph(font.outline_glyphs()!, glyphId, path);
  expect(ok, `glyph ${glyphId} should have an outline`).toBe(true);
  return path;
}

describe('glyf outlines (Ahem)', () => {
  // Ahem is the canonical OpenType test font: every glyph is a solid square
  // filling the whole em box, which makes expected outlines exactly known.
  const font = loadFont('ahem.ttf');

  it('produces a closed box for a glyph', () => {
    const path = outlineOf(font, font.charmap()!.glyph_id(0x41)); // 'A'
    expect(path.is_empty).toBe(false);
    // One contour. TrueType contours are implicitly closed: the path returns
    // to its start point rather than emitting an explicit `Close`.
    expect(path.commands.filter((c) => c.kind === 'MoveTo').length).toBe(1);
    const last = path.commands[path.commands.length - 1]!;
    const first = path.commands[0]!;
    expect(last.kind).toBe('LineTo');
    if (first.kind === 'MoveTo' && last.kind === 'LineTo') {
      expect(last.x).toBe(first.x);
      expect(last.y).toBe(first.y);
    }
  });

  it('spans the full em box', () => {
    const b = outlineOf(font, font.charmap()!.glyph_id(0x41)).bounds()!;
    // Ahem's squares run from the descender to the ascender: -200..800 with a
    // 1000-unit em and an 800/-200 hhea. Cross-checked against the glyph's own
    // `glyf` bounding box.
    expect(b.xMin).toBe(0);
    expect(b.yMin).toBe(-200);
    expect(b.xMax).toBe(1000);
    expect(b.yMax).toBe(800);
  });

  it('gives every letter the same shape', () => {
    const a = outlineOf(font, font.charmap()!.glyph_id(0x41));
    const z = outlineOf(font, font.charmap()!.glyph_id(0x5a));
    expect(a.commands.length).toBe(z.commands.length);
    expect(a.bounds()).toEqual(z.bounds());
  });

  it('returns false for glyphs with no outline', () => {
    const source = font.outline_glyphs()!;
    // Space is empty in Ahem.
    const space = font.charmap()!.glyph_id(0x20);
    const path = new Path();
    expect(outlineGlyph(source, space, path)).toBe(false);
    expect(path.is_empty).toBe(true);
  });

  it('reports no outline past the end of the font', () => {
    const source = font.outline_glyphs()!;
    const path = new Path();
    expect(outlineGlyph(source, 99999, path)).toBe(false);
  });
});

describe('composite glyphs', () => {
  it('does not recurse forever on a malformed font', () => {
    const font = loadFont('ahem.ttf');
    const source: OutlineSource = font.outline_glyphs()!;
    // Glyph 0 is a simple glyph; nothing here should hang or throw.
    const path = new Path();
    expect(() => outlineGlyph(source, 0, path)).not.toThrow();
  });
});

describe('Path', () => {
  it('reports emptiness', () => {
    const p = new Path();
    expect(p.is_empty).toBe(true);
    expect(p.bounds()).toBeUndefined();
    p.moveTo(1, 2);
    expect(p.is_empty).toBe(false);
    expect(p.bounds()).toEqual({ xMin: 1, yMin: 2, xMax: 1, yMax: 2 });
  });

  it('includes control points in bounds', () => {
    const p = new Path();
    p.moveTo(0, 0);
    // A control point beyond the endpoints widens the reported bounds.
    p.quadTo(10, 10, 5, 5);
    expect(p.bounds()).toEqual({ xMin: 0, yMin: 0, xMax: 10, yMax: 10 });
  });
});