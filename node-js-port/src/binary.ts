/**
 * Big-endian binary readers for OpenType tables.
 *
 * All OpenType data is big-endian, and the `DataView` methods for that are
 * signed/unsigned and offset-sensitive in ways that are easy to get wrong, so
 * they are wrapped once here.
 *
 * Out-of-bounds reads throw a `RangeError` rather than returning garbage, which
 * matches `read-fonts` returning `Err`.
 */

export class TableReader {
  readonly view: DataView;
  readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get length(): number {
    return this.bytes.byteLength;
  }

  u8(offset: number): number {
    return this.view.getUint8(offset);
  }

  i8(offset: number): number {
    return this.view.getInt8(offset);
  }

  u16(offset: number): number {
    return this.view.getUint16(offset, false);
  }

  i16(offset: number): number {
    return this.view.getInt16(offset, false);
  }

  u32(offset: number): number {
    return this.view.getUint32(offset, false);
  }

  i32(offset: number): number {
    return this.view.getInt32(offset, false);
  }

  f2dot14(offset: number): number {
    return this.i16(offset) / 16384;
  }

  /** A `Fixed` (16.16) value. */
  fixed(offset: number): number {
    return this.i32(offset) / 65536;
  }

  /** Four-character tag as a string, e.g. `'glyf'`. */
  tag(offset: number): string {
    return String.fromCharCode(this.u8(offset), this.u8(offset + 1), this.u8(offset + 2), this.u8(offset + 3));
  }

  /** A slice view, without copying. */
  slice(start: number, length?: number): TableReader {
    const end = length === undefined ? this.bytes.byteLength : start + length;
    return new TableReader(this.bytes.subarray(start, end));
  }

  /** Is the whole `[start, end)` range inside the buffer? */
  has(start: number, length: number): boolean {
    return start >= 0 && length >= 0 && start + length <= this.bytes.byteLength;
  }
}

/** A 16.16 fixed-point number, as used by FreeType-compatible scaling. */
export class Fixed {
  constructor(readonly bits: number) {}

  static from_int(v: number): Fixed {
    return new Fixed(v << 16);
  }

  to_float(): number {
    return this.bits / 65536;
  }

  /** `self * value` with 16.16 saturation to signed 32-bit. */
  mul(other: Fixed): Fixed {
    return new Fixed(sat_i32(Math.trunc((this.bits * other.bits) / 65536)));
  }

  div(other: Fixed): Fixed {
    return new Fixed(sat_i32(Math.trunc((this.bits << 16) / other.bits)));
  }

  /**
   * `self.mul_div(a, b)`, matching the `Fixed::mul_div` pattern used by
   * FreeType metric scaling.
   */
  mul_div(a: Fixed, b: Fixed): Fixed {
    return a.mul(this).div(b);
  }
}

function sat_i32(v: number): number {
  if (Number.isNaN(v)) return 0;
  const t = Math.trunc(v);
  if (t < -2147483648) return -2147483648;
  if (t > 2147483647) return 2147483647;
  return t;
}