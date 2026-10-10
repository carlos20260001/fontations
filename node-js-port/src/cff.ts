/**
 * Glyph outline extraction from `CFF ` (Type 2 charstrings).
 *
 * Ported from `skrifa/src/outline/cff/` and `read-fonts/src/ps/cs.rs`.
 * Produces a path of contours using cubic Bézier segments.
 *
 * Four details were the difference between producing garbage and matching
 * upstream; all four are commented at their implementation sites:
 *
 *  1. A DICT reads `29` as a 32-bit integer while a Type 2 charstring treats
 *     `29` as the `callgsubr` operator. Dividing a large table offset by 65536
 *     points the CharStrings INDEX at the wrong place and yields empty
 *     outlines.
 *  2. The `255` operator pushes a **4-byte** raw 16.16 fixed point value, not
 *     a single byte.
 *  3. The optional leading `width` operand is present only when the stack has
 *     an **odd** length *and* no width has been seen yet, and it is discarded
 *     rather than used for drawing.
 *  4. The `FontMatrix` must be normalized (divided by its own scale) before it
 *     is applied, or outlines come out at the wrong size.
 *
 * All byte reads go through bounds-checked helpers rather than raw indexing:
 * a malformed table must yield a short read as `0`, not throw.
 */

import { Path } from './outline.js';

/** Reads a byte, returning 0 when out of range. */
function u8(d: Uint8Array, i: number): number {
  return i >= 0 && i < d.length ? (d[i] as number) : 0;
}

/** Reads a big-endian u16. */
function u16(d: Uint8Array, i: number): number {
  return (u8(d, i) << 8) | u8(d, i + 1);
}

/** Reads a big-endian i16. */
function i16(d: Uint8Array, i: number): number {
  const v = u16(d, i);
  return v & 0x8000 ? v - 0x10000 : v;
}

/** Reads a big-endian i32. */
function i32(d: Uint8Array, i: number): number {
  return (u8(d, i) << 24) | (u8(d, i + 1) << 16) | (u8(d, i + 2) << 8) | u8(d, i + 3);
}

/** Reads a big-endian 16.16 fixed point value. */
function fixed(d: Uint8Array, i: number): number {
  return i32(d, i) / 65536;
}

/** Operand stack access, defaulting an absent operand to 0. */
function at(s: number[], k: number): number {
  return s[k] ?? 0;
}

/** A CFF INDEX: a count plus a run of byte ranges. */
class Index {
  readonly items: Uint8Array[] = [];
  readonly start: number;

  constructor(
    private readonly table: Uint8Array,
    start: number,
  ) {
    this.start = start;
    const count = u16(table, start);
    if (count === 0) return;
    const offSize = u8(table, start + 2);
    const offsets: number[] = [];
    let p = start + 3;
    for (let i = 0; i <= count; i++) {
      let v = 0;
      for (let b = 0; b < offSize; b++) v = (v << 8) | u8(table, p++);
      offsets.push(v);
    }
    // Offsets are 1-based relative to the byte after the offset array, so the
    // base is the current position, not one byte before it. Ground truth: in
    // Source Sans Pro the Name INDEX (@4, offSize 1, offsets [1,22]) has its
    // 21-byte item at byte 9 onward, spelling "SourceSansPro-Regular", and `p`
    // is exactly 9.
    const base = p;
    for (let i = 0; i < count; i++) {
      const from = base + (offsets[i] ?? 0) - 1;
      const to = base + (offsets[i + 1] ?? 0) - 1;
      this.items.push(table.subarray(Math.max(0, from), Math.max(from, to)));
    }
  }

  /**
   * Total bytes this INDEX occupies, so the next one can be located.
   *
   * The last item's exclusive end is itself the INDEX's end, so the span is
   * simply `end - start`. Getting this wrong — or getting `base` wrong — shifts
   * the whole header walk: the Top DICT loses its trailing Private entry, every
   * charstring is clipped by one byte, and the CharStrings INDEX can end up
   * pointed at offset 0 (the CFF header), which reads as 256 empty outlines.
   */
  get totalSize(): number {
    const last = this.items[this.items.length - 1];
    if (!last) return 2;
    const end = last.byteOffset + last.byteLength - this.table.byteOffset;
    return end - this.start;
  }

  /** PostScript Type 2 subroutine-number bias. */
  get bias(): number {
    const n = this.items.length;
    return n < 1240 ? 107 : n < 33900 ? 1131 : 32768;
  }
}

/**
 * A CFF DICT operator. The escaped `12 x` form is folded above 0xff so it
 * cannot collide with a one-byte operator.
 */
const ESCAPE_BASE = 0x0c00;

/** Reads a CFF DICT into a map from operator to operand list. */
function parseDict(data: Uint8Array): Map<number, number[]> {
  const result = new Map<number, number[]>();
  let operands: number[] = [];
  let i = 0;

  while (i < data.length) {
    const b0 = u8(data, i);
    if (b0 <= 21) {
      i++;
      const key = b0 === 12 ? ESCAPE_BASE | u8(data, i++) : b0;
      result.set(key, operands);
      operands = [];
      continue;
    }
    i += readNumber(data, i, (v) => operands.push(v), true);
  }
  return result;
}

/**
 * Reads one number starting at `i`, appends it via `emit`, and returns the
 * bytes consumed.
 *
 * Detail (1): CFF has two number grammars that do **not** agree.
 *
 *  - In a DICT, `29` pushes a 32-bit integer and only `255` is 16.16 fixed.
 *    Table offsets are large and are commonly stored under `29`.
 *  - In a Type 2 charstring, `29` is the `callgsubr` *operator*, `255` is the
 *    16.16 fixed point value, and 32..254 are the packed integers.
 *
 * `28` (int16) is the same in both.
 */
function readNumber(data: Uint8Array, i: number, emit: (v: number) => void, dict: boolean): number {
  const b0 = u8(data, i);
  if (b0 === 28) {
    emit(i16(data, i + 1));
    return 3;
  }
  if (b0 === 29 && dict) {
    emit(i32(data, i + 1));
    return 5;
  }
  if (b0 === 255) {
    // Detail (2): `255` is a **4-byte** raw 16.16 fixed point value. Reading it
    // as one byte desynchronizes the whole operand stream.
    emit(fixed(data, i + 1));
    return 5;
  }
  if (b0 === 30) {
    let s = '';
    let p = i + 1;
    done: for (;;) {
      const byte = u8(data, p++);
      for (const nib of [byte >> 4, byte & 0xf]) {
        if (nib <= 9) s += String(nib);
        else if (nib === 0xa) s += '.';
        else if (nib === 0xb) s += '-';
        else if (nib === 0xc) s += 'E';
        else if (nib >= 0xe) break done;
      }
    }
    emit(s === '' ? 0 : parseFloat(s) || 0);
    return p - i;
  }
  if (b0 >= 247) {
    const b1 = u8(data, i + 1);
    emit(b0 < 251 ? (b0 - 247) * 256 + b1 + 108 : -((b0 - 251) * 256 + b1) - 108);
    return 2;
  }
  emit(b0 - 139);
  return 1;
}

/** The scale factor and matrix mapping charstring space to UPEM space. */
export interface FontMatrix {
  /** Units per em implied by the matrix. */
  upem: number;
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

/**
 * Detail (4): normalizes a `FontMatrix` DICT operand.
 *
 * The matrix maps charstring space to em space, and its scale
 * `sqrt(|ad - bc|)` is typically `0.001`. Dividing the matrix by that scale
 * yields an effectively identity transform whose implied UPEM is `1 / scale`
 * (1000 for the usual `0.001`) — the same space `glyf` outlines live in, so
 * the two sources produce comparable coordinates.
 */
export function normalizeMatrix(values: number[] | undefined): FontMatrix {
  const m = values && values.length >= 6 ? values : [0.001, 0, 0, 0.001, 0, 0];
  const [a0 = 0.001, b0 = 0, c0 = 0, d0 = 0.001, tx0 = 0, ty0 = 0] = m;
  const scale = Math.sqrt(Math.abs(a0 * d0 - b0 * c0)) || 0.001;
  return {
    upem: 1 / scale,
    a: a0 / scale,
    b: b0 / scale,
    c: c0 / scale,
    d: d0 / scale,
    tx: tx0 / scale,
    ty: ty0 / scale,
  };
}

const MAX_SUBR_DEPTH = 10;

interface Subrs {
  gsubrs: Index | undefined;
  lsubrs: Index | undefined;
  nominalWidthX: number;
  defaultWidthX: number;
}

/** Evaluates Type 2 charstrings into a `Path`. */
class Interpreter {
  x = 0;
  y = 0;
  private stack: number[] = [];
  private seenWidth = false;
  private open = false;
  private depth = 0;

  constructor(
    private readonly path: Path,
    private readonly m: FontMatrix,
    private readonly subrs: Subrs,
  ) {}

  /** Applies the normalized font matrix. */
  private tx(x: number, y: number): [number, number] {
    return [this.m.a * x + this.m.c * y + this.m.tx, this.m.b * x + this.m.d * y + this.m.ty];
  }

  private moveTo(nx: number, ny: number): void {
    this.x = nx;
    this.y = ny;
    this.open = true;
    this.path.moveTo(...this.tx(nx, ny));
  }

  private lineTo(nx: number, ny: number): void {
    if (!this.open) {
      this.moveTo(nx, ny);
      return;
    }
    this.x = nx;
    this.y = ny;
    this.path.lineTo(...this.tx(nx, ny));
  }

  private curveTo(c1x: number, c1y: number, c2x: number, c2y: number, nx: number, ny: number): void {
    if (!this.open) {
      // A curve with no preceding move is malformed. Start the contour at the
      // curve's own start so the remainder of the outline stays well formed.
      this.moveTo(c1x, c1y);
    }
    this.x = nx;
    this.y = ny;
    this.path.cubicTo(...this.tx(c1x, c1y), ...this.tx(c2x, c2y), ...this.tx(nx, ny));
  }

  /**
   * Detail (3): discards the optional leading `width` operand.
   *
   * Type 2 puts the advance width in front of the first stack-clearing
   * operator, and only when the operand count is odd and no width has been
   * seen yet. Popping it unconditionally corrupts every coordinate after it.
   */
  private takeWidth(): void {
    if (this.stack.length & 1) this.stack.shift();
  }

  /** Runs one charstring or subroutine; false once `endchar` ends it. */
  execute(data: Uint8Array): boolean {
    const s = this.stack;
    let i = 0;

    for (;;) {
      if (i >= data.length) return true;
      // Consume the opcode as it is read; the interpreter would otherwise
      // re-read the same operator forever.
      const b0 = u8(data, i);
      i++;

      if (b0 >= 32 || b0 === 28) {
        // `b0` is itself the first byte of the number, and readNumber re-reads
        // it, so it must be handed the pre-increment position.
        i = i - 1 + readNumber(data, i - 1, (v) => s.push(v), false);
        continue;
      }

      if (b0 === 12) {
        i = this.escaped(u8(data, i), i + 1);
        continue;
      }

      switch (b0) {
        case 1: // hstem
        case 3: // vstem
        case 18: // hstemhm
        case 23: // vstemhm
          if (!this.seenWidth) {
            this.takeWidth();
            this.seenWidth = true;
          }
          s.length = 0;
          break;

        case 19: // hintmask
        case 20: // cntrmask
          if (!this.seenWidth) {
            this.takeWidth();
            this.seenWidth = true;
          }
          // The mask is one byte per stem, rounded up.
          i += Math.ceil(s.length / 2 / 8);
          s.length = 0;
          break;

        case 21: // rmoveto
          this.takeWidth();
          this.seenWidth = true;
          this.moveTo(this.x + at(s, 0), this.y + at(s, 1));
          s.length = 0;
          break;
        case 22: // hmoveto
          this.takeWidth();
          this.seenWidth = true;
          this.moveTo(this.x + at(s, 0), this.y);
          s.length = 0;
          break;
        case 4: // vmoveto
          this.takeWidth();
          this.seenWidth = true;
          this.moveTo(this.x, this.y + at(s, 0));
          s.length = 0;
          break;

        case 5: // rlineto
          for (let k = 0; k + 1 < s.length; k += 2) this.lineTo(this.x + at(s, k), this.y + at(s, k + 1));
          s.length = 0;
          break;

        case 6: // hlineto
        case 7: // vlineto
          for (let k = 0, horiz = b0 === 6; k < s.length; k++, horiz = !horiz) {
            if (horiz) this.lineTo(this.x + at(s, k), this.y);
            else this.lineTo(this.x, this.y + at(s, k));
          }
          s.length = 0;
          break;

        case 8: // rrcurveto
          for (let k = 0; k + 5 < s.length; k += 6) {
            const c1x = this.x + at(s, k);
            const c1y = this.y + at(s, k + 1);
            const c2x = c1x + at(s, k + 2);
            const c2y = c1y + at(s, k + 3);
            this.curveTo(c1x, c1y, c2x, c2y, c2x + at(s, k + 4), c2y + at(s, k + 5));
          }
          s.length = 0;
          break;

        case 24: { // rcurveline
          let k = 0;
          for (; k + 5 < s.length - 2; k += 6) {
            const c1x = this.x + at(s, k);
            const c1y = this.y + at(s, k + 1);
            const c2x = c1x + at(s, k + 2);
            const c2y = c1y + at(s, k + 3);
            this.curveTo(c1x, c1y, c2x, c2y, c2x + at(s, k + 4), c2y + at(s, k + 5));
          }
          this.lineTo(this.x + at(s, k), this.y + at(s, k + 1));
          s.length = 0;
          break;
        }

        case 25: { // rlinecurve
          let k = 0;
          for (; k + 7 < s.length; k += 2) this.lineTo(this.x + at(s, k), this.y + at(s, k + 1));
          const c1x = this.x + at(s, k);
          const c1y = this.y + at(s, k + 1);
          const c2x = c1x + at(s, k + 2);
          const c2y = c1y + at(s, k + 3);
          this.curveTo(c1x, c1y, c2x, c2y, c2x + at(s, k + 4), c2y + at(s, k + 5));
          s.length = 0;
          break;
        }

        case 26: // vvcurveto
        case 27: { // hhcurveto
          let d1 = 0;
          if (s.length % 4 === 1) d1 = s.shift() ?? 0;
          const vert = b0 === 26;
          for (let k = 0; k + 3 < s.length; k += 4) {
            const c1x = vert ? this.x : this.x + at(s, k);
            const c1y = vert ? this.y + at(s, k) : this.y;
            const c2x = c1x + at(s, k + 1);
            const c2y = c1y + at(s, k + 2);
            this.curveTo(c1x, c1y, c2x, c2y, c2x + at(s, k + 3), c2y + d1);
          }
          s.length = 0;
          break;
        }

        case 30: // vhcurveto
        case 31: { // hvcurveto
          let horiz = b0 === 31;
          let k = 0;
          while (k + 3 < s.length) {
            const last = s.length - k === 5;
            const c1x = horiz ? this.x + at(s, k) : this.x;
            const c1y = horiz ? this.y : this.y + at(s, k);
            const c2x = c1x + at(s, k + 1);
            const c2y = c1y + at(s, k + 2);
            const endX = last ? at(s, k + 4) : c2x + at(s, k + 3);
            const endY = last ? c2y : c2y + at(s, k + 3);
            this.curveTo(c1x, c1y, c2x, c2y, endX, endY);
            k += last ? 5 : 4;
            horiz = !horiz;
          }
          s.length = 0;
          break;
        }

        case 10: // callsubr
        case 29: { // callgsubr
          const local = b0 === 10;
          const index = local ? this.subrs.lsubrs : this.subrs.gsubrs;
          const target = index?.items[Math.round(s.pop() ?? 0) + index.bias];
          if (target && this.depth < MAX_SUBR_DEPTH) {
            this.depth++;
            this.execute(target);
            this.depth--;
            this.seenWidth = true;
          }
          break;
        }

        case 11: // return
          break;

        case 14: // endchar
          if (this.open) this.path.close();
          return false;

        default:
          // Unknown/reserved operators: FreeType ignores them.
          break;
      }
    }
  }

  /** Handles a `12 x` operator; returns the new read position. */
  private escaped(b1: number, i: number): number {
    const s = this.stack;
    switch (b1) {
      case 35: { // flex
        for (let k = 0; k + 11 < s.length; k += 12) {
          const c1x = this.x + at(s, k);
          const c1y = this.y + at(s, k + 1);
          const c2x = c1x + at(s, k + 2);
          const c2y = c1y + at(s, k + 3);
          this.curveTo(c1x, c1y, c2x, c2y, c2x + at(s, k + 4), c2y + at(s, k + 5));
          const d1x = this.x + at(s, k + 6);
          const d1y = this.y + at(s, k + 7);
          const d2x = d1x + at(s, k + 8);
          const d2y = d1y + at(s, k + 9);
          this.curveTo(d1x, d1y, d2x, d2y, d2x + at(s, k + 10), d2y + at(s, k + 11));
        }
        s.length = 0;
        break;
      }
      case 34: { // hflex
        const y0 = this.y;
        const c1x = this.x + at(s, 0);
        const c1y = y0;
        const c2x = c1x + at(s, 1);
        const c2y = c1y + at(s, 2);
        this.curveTo(c1x, c1y, c2x, c2y, c2x + at(s, 3), c2y + at(s, 4));
        const d1x = this.x + at(s, 5);
        const d1y = c2y + at(s, 6);
        this.curveTo(d1x, d1y, d1x + at(s, 7), d1y, d1x + at(s, 7) + at(s, 8), y0);
        s.length = 0;
        break;
      }
      case 36: { // hflex1
        const y0 = this.y;
        const c1x = this.x + at(s, 0);
        const c1y = y0;
        const c2x = c1x + at(s, 1);
        const c2y = c1y + at(s, 2);
        this.curveTo(c1x, c1y, c2x, c2y, c2x + at(s, 3), c2y + at(s, 4));
        const d1x = this.x + at(s, 5);
        const d1y = c2y + at(s, 6);
        this.curveTo(d1x, d1y, d1x + at(s, 7), d1y + at(s, 8), this.x + at(s, 9), y0);
        s.length = 0;
        break;
      }
      case 37: { // flex1
        const dx = at(s, 0) + at(s, 2) + at(s, 4);
        const dy = at(s, 1) + at(s, 3) + at(s, 5);
        const c1x = this.x + at(s, 0);
        const c1y = this.y + at(s, 1);
        const c2x = c1x + at(s, 2);
        const c2y = c1y + at(s, 3);
        const jx = c2x + at(s, 4);
        const jy = c2y + at(s, 5);
        this.curveTo(c1x, c1y, c2x, c2y, jx, jy);
        // flex1's final segment is longer in whichever axis is greater.
        if (Math.abs(dx) > Math.abs(dy)) {
          const c3x = jx + at(s, 6);
          const c3y = jy + at(s, 7);
          this.curveTo(c3x, c3y, this.x + at(s, 8), jy + at(s, 7), this.x + dx, this.y);
        } else {
          const c3x = jx + at(s, 6);
          const c3y = jy + at(s, 7);
          this.curveTo(c3x, c3y, jx + at(s, 6), this.y + at(s, 8), this.x, this.y + dy);
        }
        s.length = 0;
        break;
      }
      default:
        // Other escaped operators (arithmetic, storage, seac) do not draw.
        // Type 2 arithmetic is not needed to produce outlines.
        break;
    }
    s.length = 0;
    return i;
  }
}

/**
 * A parsed `CFF ` table, ready to produce outlines.
 *
 * Non-CID fonts use a single Private DICT. CID-keyed fonts use an FDArray with
 * one Font DICT and Private DICT per glyph, selected by an FDSelect table.
 */
export class CffSource {
  private readonly charstrings: Index;
  private readonly gsubrs: Index | undefined;
  private readonly lsubrs: Map<number, Index> = new Map();
  private readonly nominalWidthX: Map<number, number> = new Map();
  private readonly defaultWidthX: Map<number, number> = new Map();
  private readonly fdSelect: Uint8Array | undefined;
  readonly matrix: FontMatrix;

  constructor(private readonly table: Uint8Array) {
    const headerSize = u8(table, 2);
    // Header, then Name, Top DICT, String and Global Subr INDEXes.
    let off = headerSize;
    off += new Index(table, off).totalSize;
    const topDicts = new Index(table, off);
    off += topDicts.totalSize;
    off += new Index(table, off).totalSize; // String INDEX
    this.gsubrs = new Index(table, off);

    const top = parseDict(topDicts.items[0] ?? new Uint8Array(0));
    this.charstrings = new Index(table, Math.round(top.get(17)?.[0] ?? 0));
    // A CID font may additionally carry a matrix on its Font DICT, which
    // skrifa combines with the Top DICT matrix; the common case is Top only.
    this.matrix = normalizeMatrix(top.get(ESCAPE_BASE | 7));

    const fdArray = Math.round(top.get(ESCAPE_BASE | 36)?.[0] ?? 0);
    if (fdArray > 0) {
      const fds = new Index(table, fdArray);
      for (let g = 0; g < fds.items.length; g++) this.addPrivate(g, parseDict(fds.items[g] ?? EMPTY));
      const fdSelect = Math.round(top.get(ESCAPE_BASE | 37)?.[0] ?? 0);
      if (fdSelect > 0) this.fdSelect = table.subarray(fdSelect);
    } else {
      this.addPrivate(0, top);
    }
  }

  /** Records the Private DICT for glyph group `gid`. */
  private addPrivate(gid: number, dict: Map<number, number[]>): void {
    const priv = dict.get(18);
    if (!priv || priv.length < 2) return;
    const size = Math.round(priv[0] ?? 0);
    const start = Math.round(priv[1] ?? 0);
    // Private DICT and Local Subrs are addressed relative to the table.
    const pd = parseDict(this.table.subarray(start, start + size));
    this.nominalWidthX.set(gid, Math.round(pd.get(21)?.[0] ?? 0));
    this.defaultWidthX.set(gid, Math.round(pd.get(20)?.[0] ?? 0));
    const subrsRel = pd.get(19)?.[0];
    if (subrsRel !== undefined) {
      this.lsubrs.set(gid, new Index(this.table, start + Math.round(subrsRel)));
    }
  }

  get glyphCount(): number {
    return this.charstrings.items.length;
  }

  /** The `FDSelect` font group for a CID glyph, or 0. */
  private fontGroup(gid: number): number {
    const sel = this.fdSelect;
    if (!sel) return 0;
    const format = u8(sel, 0);
    if (format === 0) return u8(sel, gid + 1);
    if (format === 3) {
      const nRanges = u16(sel, 1);
      let first = u16(sel, 3);
      for (let r = 0; r < nRanges; r++) {
        const fd = u8(sel, 5 + r);
        const next = u16(sel, 6 + r * 3);
        if (gid >= first && gid < next) return fd;
        first = next;
      }
      return u8(sel, 5 + nRanges);
    }
    return 0;
  }

  /**
   * Appends the outline of `glyphId` to `path`. Returns false when the glyph
   * has no outline (space, and other whitespace).
   */
  outline(glyphId: number, path: Path): boolean {
    const data = this.charstrings.items[glyphId];
    if (!data) return false;
    const group = this.fontGroup(glyphId);
    const before = path.commands.length;
    const interp = new Interpreter(path, this.matrix, {
      gsubrs: this.gsubrs,
      lsubrs: this.lsubrs.get(group),
      nominalWidthX: this.nominalWidthX.get(group) ?? 0,
      defaultWidthX: this.defaultWidthX.get(group) ?? 0,
    });
    interp.execute(data);
    return path.commands.length > before;
  }
}

const EMPTY = new Uint8Array(0);
