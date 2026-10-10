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
| `outline/` | glyph outlines (path) extraction | TODO |
| `instance.rs` | collection + `FontRef` handle, metrics | TODO |

Not ported (egui does not use them): `attribute.rs`, `bitmap.rs`,
`color/`, `decycler.rs`, `glyph_name.rs` (`HB_TINY`-stripped in the JS
shaper too), `setting.rs`, `variation.rs`, `string.rs`.

## Interaction with the shaper

`skrifa` handles metrics and outlines; **shaping** is a separate concern and is
handled by [HarfBuzzJS](https://harfbuzz.github.io/harfbuzzjs), which replaces
`harfrust`. See `PORTING.md` in the main `egui-node` repo.

## Licence

This port is `MIT OR Apache-2.0`, matching the upstream crate.