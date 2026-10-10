/**
 * Glyph outline extraction from `glyf` (TrueType).
 *
 * Ported from `skrifa/src/outline/glyf/`. Produces a path of contours using
 * quadratic Bézier segments, matching the OpenType `glyf` format.
 *
 * `CFF `/`CFF2` outlines are in `cff.ts`.
 */

import type { OutlineSource } from './sfnt.js';
import type { TableReader } from './binary.js';

/** Path commands, mirroring the segment kinds a `glyf` contour can contain. */
export type PathCommand =
  | { kind: 'MoveTo'; x: number; y: number }
  | { kind: 'LineTo'; x: number; y: number }
  | { kind: 'QuadTo'; cx: number; cy: number; x: number; y: number }
  | { kind: 'Close' };

/** A glyph outline: a sequence of contours. */
export class Path {
  readonly commands: PathCommand[] = [];

  moveTo(x: number, y: number): void {
    this.commands.push({ kind: 'MoveTo', x, y });
  }

  lineTo(x: number, y: number): void {
    this.commands.push({ kind: 'LineTo', x, y });
  }

  quadTo(cx: number, cy: number, x: number, y: number): void {
    this.commands.push({ kind: 'QuadTo', cx, cy, x, y });
  }

  close(): void {
    this.commands.push({ kind: 'Close' });
  }

  get is_empty(): boolean {
    return this.commands.length === 0;
  }

  /** Axis-aligned bounds of the on/off curve control points. */
  bounds(): { xMin: number; yMin: number; xMax: number; yMax: number } | undefined {
    let xMin = Number.POSITIVE_INFINITY;
    let yMin = Number.POSITIVE_INFINITY;
    let xMax = Number.NEGATIVE_INFINITY;
    let yMax = Number.NEGATIVE_INFINITY;
    let any = false;
    const acc = (x: number, y: number) => {
      any = true;
      if (x < xMin) xMin = x;
      if (y < yMin) yMin = y;
      if (x > xMax) xMax = x;
      if (y > yMax) yMax = y;
    };
    for (const c of this.commands) {
      switch (c.kind) {
        case 'MoveTo':
        case 'LineTo':
          acc(c.x, c.y);
          break;
        case 'QuadTo':
          acc(c.cx, c.cy);
          acc(c.x, c.y);
          break;
        case 'Close':
          break;
      }
    }
    return any ? { xMin, yMin, xMax, yMax } : undefined;
  }
}

/** On/off-curve flag bits from the `glyf` simple-glyph description. */
const FLAG_ON_CURVE = 0x01;
const FLAG_X_SHORT = 0x02;
const FLAG_Y_SHORT = 0x04;
const FLAG_REPEAT = 0x08;
const FLAG_X_SAME_OR_POSITIVE = 0x10;
const FLAG_Y_SAME_OR_POSITIVE = 0x20;

/** Composite-glyph flags. */
const ARG_1_AND_2_ARE_WORDS = 0x0001;
const ARGS_ARE_XY_VALUES = 0x0002;
const WE_HAVE_A_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
const WE_HAVE_A_TWO_BY_TWO = 0x0080;
const WE_HAVE_INSTRUCTIONS = 0x0100;
const USE_MY_METRICS = 0x0200;

/** Guards against malformed fonts with cyclic composite references. */
const MAX_COMPOSITE_DEPTH = 5;

/**
 * Extract the outline for `glyphId` into `path`.
 *
 * @returns false if the glyph has no outline (empty glyph).
 */
export function outlineGlyph(source: OutlineSource, glyphId: number, path: Path, depth = 0): boolean {
  const data = source.glyph_data(glyphId);
  if (!data || !data.has(0, 10)) return false;

  const numberOfContours = data.i16(0);

  if (numberOfContours >= 0) {
    return outlineSimpleGlyph(data, numberOfContours, path);
  }
  if (depth >= MAX_COMPOSITE_DEPTH) {
    // Cyclic or excessively deep composite: emit nothing rather than recursing
    // forever. Matches read-fonts' depth limit.
    return false;
  }
  return outlineCompositeGlyph(source, data, path, depth);
}

function outlineSimpleGlyph(data: TableReader, numberOfContours: number, path: Path): boolean {
  let offset = 10;
  if (!data.has(offset, numberOfContours * 2 + 2)) return false;

  const endPts: number[] = [];
  for (let i = 0; i < numberOfContours; i++) {
    endPts.push(data.u16(offset + i * 2));
  }
  offset += numberOfContours * 2;

  const numPoints = numberOfContours === 0 ? 0 : endPts[numberOfContours - 1]! + 1;
  if (numPoints === 0) return false;

  const instructionLength = data.u16(offset);
  offset += 2 + instructionLength;
  if (!data.has(offset, numPoints)) return false;

  // Flags, with run-length expansion.
  const flags = new Uint8Array(numPoints);
  for (let i = 0; i < numPoints; ) {
    if (!data.has(offset, 1)) return false;
    const flag = data.u8(offset++);
    flags[i++] = flag;
    if ((flag & FLAG_REPEAT) !== 0) {
      if (!data.has(offset, 1)) return false;
      let repeat = data.u8(offset++);
      while (repeat-- > 0 && i < numPoints) {
        flags[i++] = flag;
      }
    }
  }

  // x coordinates
  const xs = new Float64Array(numPoints);
  let x = 0;
  for (let i = 0; i < numPoints; i++) {
    const flag = flags[i]!;
    if ((flag & FLAG_X_SHORT) !== 0) {
      if (!data.has(offset, 1)) return false;
      const d = data.u8(offset++);
      x += (flag & FLAG_X_SAME_OR_POSITIVE) !== 0 ? d : -d;
    } else if ((flag & FLAG_X_SAME_OR_POSITIVE) === 0) {
      if (!data.has(offset, 2)) return false;
      x += data.i16(offset);
      offset += 2;
    }
    // else: x unchanged (X_SAME_OR_POSITIVE without X_SHORT)
    xs[i] = x;
  }

  // y coordinates
  const ys = new Float64Array(numPoints);
  let y = 0;
  for (let i = 0; i < numPoints; i++) {
    const flag = flags[i]!;
    if ((flag & FLAG_Y_SHORT) !== 0) {
      if (!data.has(offset, 1)) return false;
      const d = data.u8(offset++);
      y += (flag & FLAG_Y_SAME_OR_POSITIVE) !== 0 ? d : -d;
    } else if ((flag & FLAG_Y_SAME_OR_POSITIVE) === 0) {
      if (!data.has(offset, 2)) return false;
      y += data.i16(offset);
      offset += 2;
    }
    ys[i] = y;
  }

  const onCurve = (i: number) => (flags[i]! & FLAG_ON_CURVE) !== 0;

  let start = 0;
  for (let c = 0; c < numberOfContours; c++) {
    const end = endPts[c]!;
    if (end < start) {
      start = end + 1;
      continue;
    }
    emitContour(path, onCurve, xs, ys, start, end);
    start = end + 1;
  }
  return true;
}

/**
 * Emit one contour as path commands.
 *
 * TrueType contours are made of on- and off-curve points. Two consecutive
 * off-curve points imply an on-curve point at their midpoint.
 */
function emitContour(
  path: Path,
  onCurve: (i: number) => boolean,
  xs: Float64Array,
  ys: Float64Array,
  start: number,
  end: number,
): void {
  const n = end - start + 1;
  if (n <= 0) return;

  const idx = (k: number) => start + ((((k % n) + n) % n) as number);
  const px = (k: number) => xs[idx(k)]!;
  const py = (k: number) => ys[idx(k)]!;
  const isOn = (k: number) => onCurve(idx(k));

  // Find a starting on-curve point, synthesising one if the contour is all
  // off-curve (the implied midpoint of the last and first points).
  let startK = -1;
  for (let k = 0; k < n; k++) {
    if (isOn(k)) {
      startK = k;
      break;
    }
  }

  if (startK === -1) {
    const sx = (px(0) + px(n - 1)) / 2;
    const sy = (py(0) + py(n - 1)) / 2;
    path.moveTo(sx, sy);
    startK = 0;
    emitContourBody(path, isOn, px, py, startK, n);
    return;
  }

  path.moveTo(px(startK), py(startK));
  emitContourBody(path, isOn, px, py, startK, n);
}

function emitContourBody(
  path: Path,
  isOn: (k: number) => boolean,
  px: (k: number) => number,
  py: (k: number) => number,
  startK: number,
  n: number,
): void {
  let k = 1;
  while (k <= n) {
    const i = startK + k;
    if (isOn(i)) {
      path.lineTo(px(i), py(i));
      k += 1;
      continue;
    }
    // Off-curve control point.
    const cx = px(i);
    const cy = py(i);
    if (k === n) {
      // Last point is the contour start, already moved to.
      path.quadTo(cx, cy, px(startK), py(startK));
      return;
    }
    if (isOn(i + 1)) {
      path.quadTo(cx, cy, px(i + 1), py(i + 1));
      k += 2;
    } else {
      // Implied on-curve point midway between the two controls.
      path.quadTo(cx, cy, (cx + px(i + 1)) / 2, (cy + py(i + 1)) / 2);
      k += 1;
    }
  }
}

function outlineCompositeGlyph(
  source: OutlineSource,
  data: TableReader,
  path: Path,
  depth: number,
): boolean {
  let offset = 10;
  let any = false;

  for (;;) {
    if (!data.has(offset, 4)) return any;
    const flags = data.u16(offset);
    const componentIndex = data.u16(offset + 2);
    offset += 4;

    let dx: number;
    let dy: number;
    if ((flags & ARG_1_AND_2_ARE_WORDS) !== 0) {
      if (!data.has(offset, 4)) return any;
      const a = (flags & ARGS_ARE_XY_VALUES) !== 0;
      dx = a ? data.i16(offset) : 0;
      dy = a ? data.i16(offset + 2) : 0;
      offset += 4;
    } else {
      if (!data.has(offset, 2)) return any;
      const a = data.i8(offset);
      const b = data.i8(offset + 1);
      dx = (flags & ARGS_ARE_XY_VALUES) !== 0 ? a : 0;
      dy = (flags & ARGS_ARE_XY_VALUES) !== 0 ? b : 0;
      offset += 2;
    }

    let a = 1;
    let b = 0;
    let c = 0;
    let d = 1;
    if ((flags & WE_HAVE_A_SCALE) !== 0) {
      if (!data.has(offset, 2)) return any;
      a = d = data.f2dot14(offset);
      offset += 2;
    } else if ((flags & WE_HAVE_AN_X_AND_Y_SCALE) !== 0) {
      if (!data.has(offset, 4)) return any;
      a = data.f2dot14(offset);
      d = data.f2dot14(offset + 2);
      offset += 4;
    } else if ((flags & WE_HAVE_A_TWO_BY_TWO) !== 0) {
      if (!data.has(offset, 8)) return any;
      a = data.f2dot14(offset);
      b = data.f2dot14(offset + 2);
      c = data.f2dot14(offset + 4);
      d = data.f2dot14(offset + 6);
      offset += 8;
    }

    // Decompose the component into its own path, then transform and append.
    const sub = new Path();
    if (outlineGlyph(source, componentIndex, sub, depth + 1)) {
      appendTransformed(path, sub, a, b, c, d, dx, dy);
      any = true;
    }

    if ((flags & MORE_COMPONENTS) === 0) {
      if ((flags & WE_HAVE_INSTRUCTIONS) !== 0) {
        // Skip the instruction stream; hints are not applied.
        break;
      }
      break;
    }
  }
  return any;
}

function appendTransformed(
  into: Path,
  from: Path,
  a: number,
  b: number,
  c: number,
  d: number,
  dx: number,
  dy: number,
): void {
  const tx = (x: number, y: number) => a * x + c * y + dx;
  const ty = (x: number, y: number) => b * x + d * y + dy;
  for (const cmd of from.commands) {
    switch (cmd.kind) {
      case 'MoveTo':
        into.moveTo(tx(cmd.x, cmd.y), ty(cmd.x, cmd.y));
        break;
      case 'LineTo':
        into.lineTo(tx(cmd.x, cmd.y), ty(cmd.x, cmd.y));
        break;
      case 'QuadTo':
        into.quadTo(
          tx(cmd.cx, cmd.cy),
          ty(cmd.cx, cmd.cy),
          tx(cmd.x, cmd.y),
          ty(cmd.x, cmd.y),
        );
        break;
      case 'Close':
        into.close();
        break;
    }
  }
}

/** Did any component ask to supply the metrics for the composite? */
export function compositeUsesMyMetrics(source: OutlineSource, glyphId: number): boolean {
  const data = source.glyph_data(glyphId);
  if (!data || !data.has(0, 10)) return false;
  if (data.i16(0) >= 0) return false;
  let offset = 10;
  for (;;) {
    if (!data.has(offset, 4)) return false;
    const flags = data.u16(offset);
    offset += 4 + ((flags & ARG_1_AND_2_ARE_WORDS) !== 0 ? 4 : 2);
    if ((flags & USE_MY_METRICS) !== 0) return true;
    if ((flags & MORE_COMPONENTS) === 0) return false;
  }
}