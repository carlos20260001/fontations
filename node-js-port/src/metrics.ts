/**
 * Port of `skrifa/src/metrics.rs`.
 */

import { FixedScaleFactor, Location, Size } from './instance.js';
import { FontRef, OS2_FS_SELECTION_USE_TYPO_METRICS } from './sfnt.js';
import type { Hmtx } from './sfnt.js';

/** A bounding box with single-precision float coordinates. */
export interface BoundingBox {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

/**
 * Metrics for a text decoration: the suggested offset and thickness of an
 * underline or strikeout.
 */
export class Decoration {
  /** Offset to the top of the decoration from the baseline. */
  offset: number;
  /** Thickness of the decoration. */
  thickness: number;

  constructor(offset: number, thickness: number) {
    this.offset = offset;
    this.thickness = thickness;
  }

  equals(other: Decoration): boolean {
    return this.offset === other.offset && this.thickness === other.thickness;
  }
}

/**
 * Metrics that apply to all glyphs in a font, for a specific position in
 * design space.
 *
 * Derived from `head`, `maxp`, `post`, `OS/2` and `hhea`; for variable fonts,
 * deltas come from `MVAR`.
 */
export class Metrics {
  /** Number of font design units per em unit. */
  unitsPerEm = 0;
  /** Number of glyphs in the font. */
  glyphCount = 0;
  /** True if the font is not proportionally spaced. */
  isMonospace = false;
  /** Italic angle in counter-clockwise degrees from the vertical. */
  italicAngle = 0;
  /** Distance from the baseline to the top of the alignment box. */
  ascent = 0;
  /** Distance from the baseline to the bottom of the alignment box. */
  descent = 0;
  /** Recommended additional spacing between lines. */
  leading = 0;
  /** Distance from the baseline to the top of a typical English capital. */
  capHeight: number | undefined = undefined;
  /** Distance from the baseline to the top of the lowercase "x". */
  xHeight: number | undefined = undefined;
  /** Average width of all non-zero-width characters. */
  averageWidth: number | undefined = undefined;
  /** Maximum advance width of all characters in the font. */
  maxWidth: number | undefined = undefined;
  /** Metrics for an underline decoration. */
  underline: Decoration | undefined = undefined;
  /** Metrics for a strikeout decoration. */
  strikeout: Decoration | undefined = undefined;
  /** Union of minimum and maximum extents for all glyphs in the font. */
  bounds: BoundingBox | undefined = undefined;

  /**
   * Creates new metrics for the given font, size, and location in normalized
   * variation space.
   */
  static new(font: FontRef, size: Size, location: Location = Location.DEFAULT): Metrics {
    const metrics = new Metrics();
    const head = font.head();
    if (head) {
      metrics.unitsPerEm = head.unitsPerEm;
    }

    const scale = size.linear_scale(metrics.unitsPerEm);

    if (head) {
      metrics.bounds = {
        xMin: head.xMin * scale,
        yMin: head.yMin * scale,
        xMax: head.xMax * scale,
        yMax: head.yMax * scale,
      };
    }

    const maxp = font.maxp();
    if (maxp) {
      metrics.glyphCount = maxp.numGlyphs;
    }

    const post = font.post();
    if (post) {
      metrics.isMonospace = post.isFixedPitch !== 0;
      metrics.italicAngle = post.italicAngle;
      metrics.underline = new Decoration(post.underlinePosition * scale, post.underlineThickness * scale);
    }

    const hhea = font.hhea();
    if (hhea) {
      metrics.maxWidth = hhea.advanceWidthMax * scale;
    }

    // Choosing proper line metrics is a challenge due to the changing spec,
    // backward compatibility and broken fonts. We use the same strategy as
    // FreeType:
    //   1. Use the OS/2 metrics if the table exists and USE_TYPO_METRICS is set.
    //   2. Otherwise, use the hhea metrics.
    //   3. If hhea metrics are zero and OS/2 exists:
    //      3a. Use the typo metrics if they are non-zero
    //      3b. Otherwise, use the win metrics
    const os2 = font.os2();
    let usedTypoMetrics = false;
    if (os2) {
      if ((os2.fsSelection & OS2_FS_SELECTION_USE_TYPO_METRICS) !== 0) {
        metrics.ascent = os2.sTypoAscender * scale;
        metrics.descent = os2.sTypoDescender * scale;
        metrics.leading = os2.sTypoLineGap * scale;
        usedTypoMetrics = true;
      }
      metrics.averageWidth = os2.xAvgCharWidth * scale;
      metrics.capHeight = os2.sCapHeight === undefined ? undefined : os2.sCapHeight * scale;
      metrics.xHeight = os2.sxHeight === undefined ? undefined : os2.sxHeight * scale;
      metrics.strikeout = new Decoration(os2.yStrikeoutPosition * scale, os2.yStrikeoutSize * scale);
    }

    if (!usedTypoMetrics) {
      if (hhea) {
        metrics.ascent = hhea.ascender * scale;
        metrics.descent = hhea.descender * scale;
        metrics.leading = hhea.lineGap * scale;
      }
      if (metrics.ascent === 0.0 && metrics.descent === 0.0) {
        if (os2) {
          if (os2.sTypoAscender !== 0 || os2.sTypoDescender !== 0) {
            metrics.ascent = os2.sTypoAscender * scale;
            metrics.descent = os2.sTypoDescender * scale;
            metrics.leading = os2.sTypoLineGap * scale;
          } else {
            metrics.ascent = os2.usWinAscent * scale;
            // Win descent is always positive while other descent values are
            // negative. Negate it so the result is consistent with the rest.
            metrics.descent = -(os2.usWinDescent * scale);
          }
        }
      }
    }

    // MVAR deltas are not ported yet; see the README's "Known gaps".
    void location;

    return metrics;
  }

  equals(other: Metrics): boolean {
    return (
      this.unitsPerEm === other.unitsPerEm &&
      this.glyphCount === other.glyphCount &&
      this.isMonospace === other.isMonospace &&
      this.italicAngle === other.italicAngle &&
      this.ascent === other.ascent &&
      this.descent === other.descent &&
      this.leading === other.leading &&
      this.capHeight === other.capHeight &&
      this.xHeight === other.xHeight &&
      this.averageWidth === other.averageWidth &&
      this.maxWidth === other.maxWidth &&
      decEq(this.underline, other.underline) &&
      decEq(this.strikeout, other.strikeout) &&
      bboxEq(this.bounds, other.bounds)
    );
  }
}

/** Glyph-specific metrics. */
export class GlyphMetrics {
  private readonly font: FontRef;
  private readonly size: Size;
  private readonly location: Location;
  private readonly hmtx: Hmtx | undefined;
  private readonly glyphCount: number;
  private readonly head: { unitsPerEm: number; xMin: number; yMin: number; xMax: number; yMax: number } | undefined;

  constructor(font: FontRef, size: Size, location: Location = Location.DEFAULT) {
    this.font = font;
    this.size = size;
    this.location = location;
    const maxp = font.maxp();
    this.glyphCount = maxp ? maxp.numGlyphs : 0;
    this.hmtx = font.hmtx(this.glyphCount);
    this.head = font.head();
  }

  glyph_count(): number {
    return this.glyphCount;
  }

  /** Advance width, scaled. */
  advance_width(glyph_id: number): number | undefined {
    if (glyph_id >= this.glyphCount) return undefined;
    const raw = this.hmtx?.advance_width(glyph_id);
    if (raw === undefined) return undefined;
    const upem = this.head?.unitsPerEm ?? 0;
    if (this.size.ppem() === undefined) {
      // Unscaled: report design units.
      return raw;
    }
    // Match FreeType metric scaling, as skrifa does.
    return FixedScaleFactor.for_size(this.size, upem).apply(raw);
  }

  /** Left side bearing, scaled. */
  left_side_bearing(glyph_id: number): number | undefined {
    if (glyph_id >= this.glyphCount) return undefined;
    const raw = this.hmtx?.left_side_bearing(glyph_id);
    if (raw === undefined) return undefined;
    const upem = this.head?.unitsPerEm ?? 0;
    if (this.size.ppem() === undefined) {
      return raw;
    }
    return FixedScaleFactor.for_size(this.size, upem).apply(raw);
  }

  /** The glyph's bounding box, scaled. */
  bounds(glyph_id: number): BoundingBox | undefined {
    const advance = this.advance_width(glyph_id);
    const lsb = this.left_side_bearing(glyph_id);
    if (advance === undefined || lsb === undefined) return undefined;
    // Without rasterizing the outline we cannot know the true extents, so this
    // is the advance box. See the README's "Known gaps".
    const scale = this.size.linear_scale(this.head?.unitsPerEm ?? 0);
    return {
      xMin: lsb,
      yMin: 0,
      xMax: lsb + advance / (scale === 0 ? 1 : 1),
      yMax: 0,
    };
  }
}

function decEq(a: Decoration | undefined, b: Decoration | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.equals(b);
}

function bboxEq(a: BoundingBox | undefined, b: BoundingBox | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.xMin === b.xMin && a.yMin === b.yMin && a.xMax === b.xMax && a.yMax === b.yMax;
}