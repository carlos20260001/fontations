# Node.js port: `skrifa` replacement

TypeScript replacement for [`skrifa`](https://github.com/googlefonts/fontations/tree/main/skrifa),
as used by `egui`'s `epaint` text stack.

## Why

`epaint` needs font **metrics**, a **character map**, and **glyph outlines**.
Upstream it gets these from `skrifa` (a Rust crate over `read-fonts`). This
directory holds the Node/TypeScript equivalent.

## Upstream reference

- Crate: `skrifa`, in the `fontations` monorepo (`skrifa/`).
- Version egui pins: `0.44.0` (see `egui`'s workspace `Cargo.toml`).
- Licence: `MIT OR Apache-2.0` — identical to egui's own dual licence.

## Modules to port

Only what `epaint` actually uses:

| Rust module | Purpose | TS status |
|---|---|---|
| `metrics.rs` | glyph advance, extents, vertical metrics, `advance_width()` | TODO |
| `charmap.rs` | codepoint -> glyph id | TODO |
| `outline/` | glyph outlines (path) extraction | glyf done; CFF WIP |
| `instance.rs` | collection + `FontRef` handle, metrics | TODO |

Not ported (egui does not use them): `attribute.rs`, `bitmap.rs`,
`color/`, `decycler.rs`, `glyph_name.rs` (`HB_TINY`-stripped in the JS
shaper too), `setting.rs`, `variation.rs`, `string.rs`.

## Status

Done and tested:

- sfnt container, TrueType collections, `head`/`hhea`/`hmtx`/`maxp`/
  `OS/2`/`post`/`cmap` (formats 4 and 12)/`loca`/`glyf`
- `Size` (with FreeType-compatible fixed-point scaling), `Location`,
  `FixedScaleFactor`
- `Metrics` and `GlyphMetrics`, including the FreeType line-metrics
  fallback chain
- `glyf` outlines: simple glyphs (quadratic contours, implied on-curve
  points) and composite glyphs (all transform variants, depth-limited)

**Still outstanding - do not consider this port finished:**

- **CFF / CFF2 outlines.** A first implementation was written and then
  withdrawn: the Type 2 interpreter produced degenerate paths (zero width,
  extents past the em) against a NotoSansJP subset fixture. The INDEX and
  Top-DICT handling needed fixing along the way. This needs a correct
  implementation plus fixture coverage before it can be relied on.
- **Variable fonts**: `fvar`, `avar`, `gvar`, `HVAR` (no instancing).
- **`MVAR` metric deltas**: `Metrics::new` accepts a `Location` but
  currently ignores it.
- **Colour glyphs**: `CBDT`, `sbix`, `COLR`.
- **Glyph hinting.** skrifa bundles an autohinter; epaint exposes a
  `HintingTarget`. The port is unhinted-only. This is a deliberate
  difference, not an oversight, and it is visible for small text.

## Interaction with the shaper

`skrifa` handles metrics and outlines; **shaping** is a separate concern and is
handled by [HarfBuzzJS](https://harfbuzz.github.io/harfbuzzjs), which replaces
`harfrust`. See `PORTING.md` in the main `egui-node` repo.

## Licence

This port is `MIT OR Apache-2.0`, matching the upstream crate.