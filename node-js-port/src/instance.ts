/**
 * Port of `skrifa`'s font-instance concepts: `Size`, `Location` and the
 * FreeType-compatible scale factors.
 */

import { Fixed } from './binary.js';

/**
 * A font size, in pixels per em.
 *
 * `Size.unscaled()` requests metrics/outlines in font design units rather than
 * pixels.
 */
export class Size {
  /** Raw pixels-per-em, or `undefined` when unscaled. */
  readonly ppem_: number | undefined;

  private constructor(ppem: number | undefined) {
    this.ppem_ = ppem;
  }

  /** Creates a new font size from the given value in pixels per em units. */
  static new(ppem: number): Size {
    return new Size(ppem);
  }

  /** For generating unscaled metrics or outlines in font units. */
  static unscaled(): Size {
    return new Size(undefined);
  }

  /** The raw size in pixels per em units, or `undefined` if unscaled. */
  ppem(): number | undefined {
    return this.ppem_;
  }

  /**
   * Computes a linear scale factor for this size and the given units per em.
   *
   * Returns 1.0 for an unscaled size or when `units_per_em` is 0.
   */
  linear_scale(units_per_em: number): number {
    const ppem = this.ppem_;
    return ppem !== undefined && units_per_em !== 0 ? ppem / units_per_em : 1.0;
  }

  /**
   * Computes a fixed point linear scale factor that matches FreeType.
   *
   * FreeType computes a 16.16 scale factor that converts to 26.6, in two
   * steps, assuming `FT_Set_Pixel_Size`:
   * 1. height is multiplied by 64
   * 2. this value is divided by UPEM
   */
  fixed_linear_scale(units_per_em: number): Fixed {
    const ppem = this.ppem_;
    if (ppem !== undefined && units_per_em > 0) {
      return Fixed.from_int(Math.trunc(ppem * 64)).div(Fixed.from_int(units_per_em));
    }
    // This is an identity scale for the pattern `mul_div(value, scale, 64)`.
    return new Fixed(0x10000 * 64);
  }
}

/**
 * A reference to an ordered sequence of normalized variation coordinates.
 *
 * Skrifa names the ordering by axis tag; egui's `FontTweak` always produces
 * `wght`/`wdth`/`slnt`, so the ordering here is the OpenType axis-tag order.
 */
export class Location {
  /** Normalized coordinates, keyed by axis tag. */
  readonly coords: ReadonlyMap<string, number>;

  constructor(coords: ReadonlyMap<string, number> = new Map()) {
    this.coords = coords;
  }

  static readonly DEFAULT: Location = new Location();

  /** The coordinates that actually apply, i.e. non-zero entries. */
  effective_coords(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [tag, value] of this.coords) {
      if (value !== 0) {
        out.set(tag, value);
      }
    }
    return out;
  }

  /** True when no axis is displaced from its default. */
  is_default(): boolean {
    return this.effective_coords().size === 0;
  }
}

/**
 * Mirrors skrifa's private `FixedScaleFactor`: applies FreeType-compatible
 * metric scaling to integer font-unit values.
 */
export class FixedScaleFactor {
  readonly scale: Fixed;

  constructor(scale: Fixed) {
    this.scale = scale;
  }

  static for_size(size: Size, units_per_em: number): FixedScaleFactor {
    return new FixedScaleFactor(size.fixed_linear_scale(units_per_em));
  }

  /** Apply the scale to a font-unit value, matching FreeType. */
  apply(value: number): number {
    return this.scale.mul_div(new Fixed(value), new Fixed(64)).to_float();
  }
}