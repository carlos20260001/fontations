/**
 * sfnt container and the OpenType tables `epaint` needs.
 *
 * Ported from `skrifa`, which in turn reads these through `read-fonts`. Only the
 * tables egui touches are implemented:
 *
 * | Table  | Used for |
 * |--------|----------|
 * | `head` | units per em, font bounds |
 * | `hhea` | line metrics, max advance |
 * | `hmtx` | per-glyph advance and lsb |
 * | `maxp` | glyph count |
 * | `OS/2` | cap height, x height, strikeout, typo/win metrics |
 * | `post` | italic angle, underline, monospace |
 * | `cmap` | codepoint -> glyph id |
 * | `loca` / `glyf` | outlines |
 *
 * Not implemented: `CFF `/`CFF2` (Type 2 charstrings), variable-font
 * instancing (`gvar`, `HVAR`, `avar`, `fvar`, `STAT`), colour tables
 * (`CBDT`, `sbix`, `COLR`). These are recorded as gaps in the README.
 */

import { TableReader } from './binary.js';

/** A parsed `head` table. */
export interface Head {
  unitsPerEm: number;
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
  indexToLocFormat: number;
}

/** A parsed `hhea` table. */
export interface Hhea {
  ascender: number;
  descender: number;
  lineGap: number;
  advanceWidthMax: number;
}

/** A parsed `OS/2` table (only the fields skrifa reads). */
export interface Os2 {
  version: number;
  xAvgCharWidth: number;
  usWeightClass: number;
  usWidthClass: number;
  fsSelection: number;
  sTypoAscender: number;
  sTypoDescender: number;
  sTypoLineGap: number;
  usWinAscent: number;
  usWinDescent: number;
  sxHeight: number | undefined;
  sCapHeight: number | undefined;
  yStrikeoutSize: number;
  yStrikeoutPosition: number;
}

/** A parsed `post` table (only the fields skrifa reads). */
export interface Post {
  italicAngle: number;
  underlinePosition: number;
  underlineThickness: number;
  isFixedPitch: number;
}

/** `OS/2.fsSelection` bit 7: use `sTypo*` line metrics. */
export const OS2_FS_SELECTION_USE_TYPO_METRICS = 1 << 7;

/**
 * An sfnt font: a table directory plus the parsed tables egui needs.
 *
 * Corresponds to `skrifa::FontRef`, which is a borrowed view over font bytes.
 */
export class FontRef {
  readonly bytes: Uint8Array;
  private readonly tables: Map<string, TableReader>;

  private constructor(bytes: Uint8Array, tables: Map<string, TableReader>) {
    this.bytes = bytes;
    this.tables = tables;
  }

  /**
   * `FontRef::new`: parse an sfnt font from bytes.
   *
   * @throws if the data is not a valid sfnt container.
   */
  static new(bytes: Uint8Array): FontRef {
    return FontRef.from_index(bytes, 0);
  }

  /**
   * `FontRef::from_index`: parse font number `index` from a font collection
   * (a TTC) or from a plain sfnt file.
   */
  static from_index(bytes: Uint8Array, index: number): FontRef {
    const r = new TableReader(bytes);

    let base = 0;
    if (r.tag(0) === 'ttcf') {
      const numFonts = r.u32(8);
      if (index >= numFonts) {
        throw new RangeError(`FontRef::from_index: index ${index} out of range (${numFonts} fonts)`);
      }
      base = r.u32(12 + index * 4);
    }

    const sfnt = r.slice(base);
    const numTables = sfnt.u16(4);
    const tables = new Map<string, TableReader>();
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      if (!sfnt.has(rec, 16)) {
        break;
      }
      const tag = sfnt.tag(rec);
      const offset = sfnt.u32(rec + 8);
      const length = sfnt.u32(rec + 12);
      if (sfnt.has(offset, length)) {
        tables.set(tag, new TableReader(sfnt.bytes.subarray(offset, offset + length)));
      }
    }

    const font = new FontRef(bytes, tables);
    if (!font.has('head')) {
      throw new TypeError('FontRef: font has no required `head` table');
    }
    return font;
  }

  /** Is the given table present? */
  has(tag: string): boolean {
    return this.tables.has(tag);
  }

  /** The raw bytes of a table, if present. */
  table(tag: string): TableReader | undefined {
    return this.tables.get(tag);
  }

  // --------------------------------------------------------------------------
  // Parsed tables. Each returns `undefined` when the table is absent or
  // truncated, matching skrifa's `Result`-returning accessors.
  // --------------------------------------------------------------------------

  head(): Head | undefined {
    const t = this.tables.get('head');
    if (!t || !t.has(0, 54)) return undefined;
    return {
      unitsPerEm: t.u16(18),
      // The 16.16 signed fields are the font bounds in design units.
      xMin: t.i16(36),
      yMin: t.i16(38),
      xMax: t.i16(40),
      yMax: t.i16(42),
      indexToLocFormat: t.i16(50),
    };
  }

  hhea(): Hhea | undefined {
    const t = this.tables.get('hhea');
    if (!t || !t.has(0, 36)) return undefined;
    return {
      ascender: t.i16(4),
      descender: t.i16(6),
      lineGap: t.i16(8),
      advanceWidthMax: t.u16(10),
    };
  }

  maxp(): { numGlyphs: number } | undefined {
    const t = this.tables.get('maxp');
    if (!t || !t.has(0, 6)) return undefined;
    return { numGlyphs: t.u16(4) };
  }

  post(): Post | undefined {
    const t = this.tables.get('post');
    if (!t || !t.has(0, 32)) return undefined;
    return {
      // 16.16 fixed, signed.
      italicAngle: t.fixed(4),
      underlinePosition: t.i16(8),
      underlineThickness: t.i16(10),
      isFixedPitch: t.u32(12),
    };
  }

  os2(): Os2 | undefined {
    const t = this.tables.get('OS/2');
    if (!t || !t.has(0, 78)) return undefined;
    const version = t.u16(0);
    // NB: `ulCodePageRange1`/`2` are uint32, not uint16, so they occupy
    // 78..85 and push `sxHeight`/`sCapHeight` to 86/88. Verified against a real
    // font (Ahem): reading at 82/84 yields 0 and -1, at 86/88 yields 800/800.
    const hasV2 = version >= 2 && t.has(88, 2);
    return {
      version,
      xAvgCharWidth: t.i16(2),
      usWeightClass: t.u16(4),
      usWidthClass: t.u16(6),
      fsSelection: t.u16(62),
      sTypoAscender: t.i16(68),
      sTypoDescender: t.i16(70),
      sTypoLineGap: t.i16(72),
      usWinAscent: t.u16(74),
      usWinDescent: t.u16(76),
      sxHeight: hasV2 ? t.i16(86) : undefined,
      sCapHeight: hasV2 ? t.i16(88) : undefined,
      yStrikeoutSize: t.i16(26),
      yStrikeoutPosition: t.i16(28),
    };
  }

  /** Per-glyph horizontal metrics, read lazily from `hmtx`. */
  hmtx(numGlyphs: number): Hmtx | undefined {
    const t = this.tables.get('hmtx');
    if (!t || !this.hhea()) return undefined;
    const numberOfHMetrics = this.numberOfHMetrics(numGlyphs, t.length);
    if (numberOfHMetrics === undefined) return undefined;
    return new Hmtx(t, numberOfHMetrics, numGlyphs);
  }

  /**
   * How many leading glyphs carry an advance width in `hmtx`.
   *
   * `maxp` 1.0+ stores `numberOfHMetrics` at offset 34. Older `maxp` 0.5 fonts
   * omit it, so it is derived from the table length: the table is
   * `numberOfHMetrics` long-pairs followed by `numGlyphs - numberOfHMetrics`
   * trailing left-side-bearings, i.e. `len = 4n + 2(numGlyphs - n)`.
   */
  private numberOfHMetrics(numGlyphs: number, hmtxLength: number): number | undefined {
    const maxp = this.tables.get('maxp');
    if (maxp && maxp.has(0, 4) && maxp.fixed(0) >= 1.0 && maxp.has(34, 2)) {
      return maxp.u16(34);
    }
    const n = (hmtxLength - 2 * numGlyphs) / 2;
    if (!Number.isInteger(n) || n < 0 || n > numGlyphs) return undefined;
    return n;
  }

  /** The character map, if present. */
  charmap(): Charmap | undefined {
    const t = this.tables.get('cmap');
    if (!t || !t.has(0, 4)) return undefined;
    return new Charmap(t);
  }

  /** `loca` + `glyf` outline access. Returns `undefined` for CFF outlines. */
  outline_glyphs(): OutlineSource | undefined {
    const loca = this.tables.get('loca');
    const glyf = this.tables.get('glyf');
    const head = this.head();
    if (!loca || !glyf || !head) return undefined;
    return new OutlineSource(loca, glyf, head.indexToLocFormat, head.unitsPerEm);
  }
}

/** Horizontal metrics for every glyph, from `hmtx`. */
export class Hmtx {
  private readonly t: TableReader;
  private readonly numberOfHMetrics: number;
  private readonly numGlyphs: number;

  constructor(t: TableReader, numberOfHMetrics: number, numGlyphs: number) {
    this.t = t;
    this.numberOfHMetrics = numberOfHMetrics;
    this.numGlyphs = numGlyphs;
  }

  /** Advance width in font units. */
  advance_width(glyph_id: number): number | undefined {
    const i = Math.min(glyph_id, this.numberOfHMetrics - 1);
    if (i < 0 || !this.t.has(i * 4, 4)) return undefined;
    return this.t.u16(i * 4);
  }

  /** Left side bearing in font units. */
  left_side_bearing(glyph_id: number): number | undefined {
    if (glyph_id < this.numberOfHMetrics) {
      if (!this.t.has(glyph_id * 4 + 2, 2)) return undefined;
      return this.t.i16(glyph_id * 4 + 2);
    }
    // Monospaced tail: the LSB lives in the trailing i16 array.
    const tail = this.numberOfHMetrics;
    const idx = glyph_id - tail;
    if (!this.t.has(this.numberOfHMetrics * 4 + idx * 2, 2)) return undefined;
    return this.t.i16(this.numberOfHMetrics * 4 + idx * 2);
  }

  get glyph_count(): number {
    return this.numGlyphs;
  }
}

/** Format 4 and 12 subtable codepoint -> glyph id mapping. */
export class Charmap {
  private readonly t: TableReader;
  private readonly subtable: TableReader;

  constructor(t: TableReader) {
    this.t = t;
    const numTables = t.u16(2);
    // Prefer a Unicode subtable; full-repertoire first, then BMP.
    let best = -1;
    let bestScore = -1;
    for (let i = 0; i < numTables; i++) {
      const rec = 4 + i * 8;
      if (!t.has(rec, 8)) break;
      const platformId = t.u16(rec);
      const encodingId = t.u16(rec + 2);
      const offset = t.u32(rec + 4);
      if (!t.has(offset, 2)) continue;
      const format = t.u16(offset);
      let score = -1;
      if (platformId === 3 && encodingId === 10) score = 4; // Windows UCS-4
      else if (platformId === 0 && encodingId >= 4) score = 3; // Unicode full
      else if (platformId === 3 && encodingId === 1) score = 2; // Windows BMP
      else if (platformId === 0) score = 1; // Unicode BMP
      if (score > bestScore) {
        bestScore = score;
        best = offset;
      }
    }
    this.subtable = best >= 0 ? t.slice(best) : t.slice(0);
  }

  /** The glyph id for a codepoint, or 0 (`.notdef`) if unmapped. */
  glyph_id(codepoint: number): number {
    const t = this.subtable;
    const format = t.length >= 2 ? t.u16(0) : -1;
    if (format === 4) {
      if (codepoint > 0xffff) return 0;
      return this._lookup_format4(codepoint);
    }
    if (format === 12) {
      return this._lookup_format12(codepoint);
    }
    return 0;
  }

  /** Does this font have a glyph for the codepoint? */
  has_char(codepoint: number): boolean {
    return this.glyph_id(codepoint) !== 0;
  }

  private _lookup_format4(codepoint: number): number {
    const t = this.subtable;
    const segCountX2 = t.u16(6);
    const segCount = segCountX2 / 2;
    const endCodes = 14;
    const startCodes = endCodes + segCountX2 + 2;
    const idDeltas = startCodes + segCountX2;
    const idRangeOffsets = idDeltas + segCountX2;

    for (let s = 0; s < segCount; s++) {
      const end = t.u16(endCodes + s * 2);
      if (codepoint > end) continue;
      const start = t.u16(startCodes + s * 2);
      if (codepoint < start) return 0;
      const delta = t.i16(idDeltas + s * 2);
      const rangeOffset = t.u16(idRangeOffsets + s * 2);
      if (rangeOffset === 0) {
        return (codepoint + delta) & 0xffff;
      }
      // rangeOffset is a byte offset from the idRangeOffset entry itself.
      const addr = idRangeOffsets + s * 2 + rangeOffset + (codepoint - start) * 2;
      if (!t.has(addr, 2)) return 0;
      const gid = t.u16(addr);
      return gid === 0 ? 0 : (gid + delta) & 0xffff;
    }
    return 0;
  }

  private _lookup_format12(codepoint: number): number {
    const t = this.subtable;
    const nGroups = t.u32(12);
    for (let g = 0; g < nGroups; g++) {
      const rec = 16 + g * 12;
      if (!t.has(rec, 12)) return 0;
      const startChar = t.u32(rec);
      const endChar = t.u32(rec + 4);
      if (codepoint >= startChar && codepoint <= endChar) {
        const startGlyph = t.u32(rec + 8);
        return startGlyph + (codepoint - startChar);
      }
      if (codepoint < startChar) return 0;
    }
    return 0;
  }
}

/** Glyph outlines from `loca` + `glyf`. */
export class OutlineSource {
  private readonly loca: TableReader;
  private readonly glyf: TableReader;
  private readonly indexToLocFormat: number;
  readonly unitsPerEm: number;

  constructor(loca: TableReader, glyf: TableReader, indexToLocFormat: number, unitsPerEm: number) {
    this.loca = loca;
    this.glyf = glyf;
    this.indexToLocFormat = indexToLocFormat;
    this.unitsPerEm = unitsPerEm;
  }

  /** Byte range of glyph `glyph_id` within `glyf`, or `undefined` if empty. */
  glyph_range(glyph_id: number): [number, number] | undefined {
    if (this.indexToLocFormat === 0) {
      const off = glyph_id * 2;
      if (!this.loca.has(off, 4)) return undefined;
      const start = this.loca.u16(off) * 2;
      const end = this.loca.u16(off + 2) * 2;
      return start === end ? undefined : [start, end];
    }
    const off = glyph_id * 4;
    if (!this.loca.has(off, 8)) return undefined;
    const start = this.loca.u32(off);
    const end = this.loca.u32(off + 4);
    return start === end ? undefined : [start, end];
  }

  /** The raw glyph description for `glyph_id`, or `undefined` if empty. */
  glyph_data(glyph_id: number): TableReader | undefined {
    const range = this.glyph_range(glyph_id);
    if (!range) return undefined;
    const [start, end] = range;
    if (!this.glyf.has(start, end - start)) return undefined;
    return this.glyf.slice(start, end - start);
  }
}