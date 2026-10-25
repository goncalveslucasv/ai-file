# The native Adobe Illustrator (.ai) format — reverse-engineering notes

These notes describe what [`ai-file`](../README.md) implements. They were recovered from a file
written by **Illustrator 2026 (30.6, AI24 stream)** — a real-world 647 MB business-card file with
8 artboards — by decoding the native data and checking every interpretation against the PDF
rendition that Illustrator stores in the same file (positions, colors, gradients, fonts and text
coordinates match the PDF exactly). Items marked *(inferred)* are consistent with the sample
but could not be confirmed against a second source.

Tooling: [REA](https://github.com/morluto/rea) (`rea inspect-byte-entropy`) was used for the
first map of the container: a low-entropy XMP region, then one high-entropy region that turned
out to be the compressed private data (≈410 MB, objects 154–6405) followed by the PDF
rendition (≈236 MB, mostly images). REA's binary/app analyzers (`inspect-artifact`, Ghidra/Hopper
providers) do not cover document formats — `inspect-artifact` rejects the file as an
"unsupported binary format" — and Illustrator itself was not installed, so the rest of the work
was done at file level: decompressing, tokenizing, statistics over operator sequences, and
diffing against the PDF.

## 1. Container

A PDF-compatible `.ai` is a normal PDF (one page per artboard). The first page carries:

```
/PieceInfo << /Illustrator N 0 R >>
N 0 obj << /LastModified (D:...) /Private P 0 R >>
P 0 obj << /AIMetaData M 0 R
           /AIPrivateData1 .. /AIPrivateDataK   (stream objects, 65536 bytes each)
           /ContainerVersion 12 /CreatorVersion 30 /NumBlock K
           /RoundtripStreamType 2 /RoundtripVersion 24 >>
```

* `AIMetaData` — the plain `%!PS-Adobe-3.0` header comments (uncompressed).
* `AIPrivateData1..K` — concatenated, they form the **native stream**. The first block starts with a tag:
  * `%AI24_ZStandard_Data` + zstd frame(s) — Illustrator 2020+ (`RoundtripStreamType 2`)
  * `%AI12_CompressedData` + zlib stream — Illustrator CS2–2019
  * no tag — plain text (Illustrator 9–CS)
* Legacy files without PDF compatibility are the native stream directly (optionally behind a
  DOS-EPS binary header `C5 D0 D3 C6`).

The sample decompresses from 409.7 MB to **999.2 MB** (12 MB of text, the rest raw image samples).

Illustrator only reads the private data; the PDF pages are a preview for other software.

## 2. Lexical structure of the native stream

A PostScript dialect ("AI text format", the same family as the public AI 3/7 specs, extended up to AI24):

* Lines end with `\r`.
* Operands (numbers, `(strings)`, `/names`, `[arrays]`, `<hex>`) precede an operator.
* `%` starts a comment **except** `%_`: everything after `%_` (anywhere on the line) is
  *Illustrator-only content* — a PostScript RIP skips it, Illustrator executes it. About 40%
  of the art lives there (editable sources, dictionaries, live shapes).
* `%%BeginData: N` is followed by a line break and a raw binary block that starts with its
  operator line (`XI\n`). **N is not the real length for rasters with alpha**: Illustrator
  counts only the color samples (`3 + w·h·channels`) but then writes the alpha plane too
  (`w·h` more bytes). The block is terminated by `%%EndData` (or `%_%%EndData`) with no line break.

## 3. Document layout

```
%!PS-Adobe-3.0 header comments ... %%EndComments
%%BeginSetup
  %AI5_BeginGradient … %AI5_EndGradient      gradient definitions (Bd / Bs / BD)
  %AI3_BeginPattern … %AI3_EndPattern         patterns
  %AI8_BeginBrushPattern …                    brushes
  %AI14_BeginSymbol (name) … %AI10_EndSymbol  symbols
  %AI8_BeginPluginObject …                    plugin data (brush manager…)
  %AI9_BeginArtStyles … %AI9_EndArtStyles     appearance styles (/KnownStyle)
  %AI5_BeginPalette … %AI5_EndPalette         swatches (color op + (name) Pc)
  %AI9_BeginDocumentData … %AI9_EndDocumentData   document dictionary (artboards…)
  %AI11_BeginTextDocument … %AI11_EndTextDocument text engine data (2 documents)
%%EndSetup
%AI5_BeginLayer … %AI5_EndLayer--             one block per layer (nested for sublayers)
%%PageTrailer / %%Trailer / %%EOF
```

## 4. The dictionary language

Used by art dictionaries, document data, art styles, text objects. Postfix, container based:

```
/ArtDictionary :                          open container of type ArtDictionary
1 /Real (Raster Art Original Scale) ,     typed, keyed value
7621.6 9673.6 /RealPoint (RulerOrigin) ,  multi-number value
(Chain Style Filter) 0 0 /Filter ,        attribute (values + /Name)
/NotRecorded ,                            flag
/Dictionary : … ; (key) ,                 close a child and store it under key
/Array : … ; ,                            "," without operands appends the closed child
; /Recorded ,                             close and store under a name
/XMLUID : (Layer_1) ; (AI10_ArtUID) ,     ";" can carry the container's own value
/FillStyle : 0 O … Xd /Def ;              containers can hold paint operators
… ; /Dict ;                               "/Name ;" adopts the last closed child, then closes
/Binary : /ASCII85Decode ,                payload on following comment lines, ends with ~>
```

Value types seen: `Real Int Bool String UnicodeString (UTF-8) RealPoint RealPointRelToROrigin`.

**Artboards**: `Document > Dictionary(/Recorded) > ArtboardArray[]`, each with `Name`,
`PositionPoint1/2` (corners **in art space**, despite the name), `RulerOrigin`, `ArtboardUUID`.

## 5. Coordinates

Art space: points, **y up**. PDF page *i* = artboard *i* translated so its bottom-left corner is (0,0).

## 6. Art grammar

```
layer   := Lb (name) Ln [AE] [dict] art* LB
art     := prefix* object [dict] [trailer]
prefix  := A (lock)  Xw (hidden)  Ae Ap As (kept verbatim)  D (path direction)
           + sticky graphics state: O R  g k x Xa Xx (fill)  G K X XA XX (stroke)
             w J j M d  XR (fill rule)  Xy (blend)  Xd
object  := path | u art* U | q art* Q | *u path* *U | raster | mesh | text
path    := (m | l L | c C | v V | y Y)+ [h] [W] (f F s S b B n N)
raster  := %AI5_BeginRaster (file) linked XG /DeviceRGB XN [m] w h 0 Xh
           [m] llx lly urx ury w h bits channels alpha … <XI binary> XH [Xr] %AI5_EndRaster N
mesh    := /Mesh X! (value /Key X#)* /End X!
text    := /AI11Text : n /FreeUndo , n /FrameIndex , n /StoryIndex , n /TextAntialiasing , ;
trailer := [Xy …] [Xd] code (styleName) XW
```

* **Sticky graphics state.** Objects only write the attributes that change; a path without
  color operators uses the fill of the previous object. The writer simulates this state.
* **Lowercase/uppercase** segment operators: smooth vs corner anchors. Lowercase paint ops close the path.
* **Clip groups** (`q … Q`): the clipping path (`W n`) is written **last** (topmost), not first.
* **Compound paths** `*u … *U` with per-subpath `D` direction flags.
* **Colors**: `c m y k r g b Xa` = RGB with its CMYK equivalent; `g` gray (1 = white); `k` CMYK;
  `x`/`Xx` named (spot/global) colors with tint.
* **Blend (`Xy`)**: `mode opacity isolated knockout alphaIsShape`; mode = Illustrator's
  AIBlendingMode order (normal, multiply, screen, overlay, soft light, hard light, color dodge,
  color burn, darken, lighten, difference, exclusion, hue, saturation, color, luminosity).
* **`XW` trailer** after an object: `code (styleName) XW`; code 6 when attributes (`Xd`) precede
  it, 9 otherwise, 1/0 when it names an art style *(numeric meaning beyond that: inferred)*.

### Appearances: result + editable source

Objects with a complex appearance (effects, several fills/strokes, live shapes) are written twice:

```
<result art, visible>           expanded rendering a PostScript device can draw
<trailer of the result>
%_<source art …>                the editable original (Illustrator-only)
1 (Anon 7JW80Xn4hCc=) XW        visible: closes the source and names its art style
```

The library keeps the result as the node and the original in `art.source` / `art.sourceStyle`.
Example from the sample: a clip group with two photos and a gradient, styled with a multiply
80% blend + stroke offset, is stored as a 1221×1198 rasterized result at 70% opacity plus the
hidden editable clip group.

### Gradients

`Bb … BB` wraps a painted path:
```
Bb
1 (name) ox oy angle length a b c d tx ty 1 Bg
a b c d tx ty Xm          gradient → art matrix
… Bc / Bm …               PostScript band emulation (ignored)
f
0 BB
```
Verified against the PDF shading: with `Xm` the gradient vector is the **unit vector**:
`Xm·(0,0) → Xm·(1,0)` (radial: center and radius vector). `Bg` origin/angle/length are already
folded into `Xm`. Stops (`Bs`, 12 operands in AI24): `c m y k r g b colorStyle opacity ? midpoint% location%`.
The PDF encodes the midpoint as an exponent `N = ln 0.5 / ln midpoint`.

### Rasters

`Xh` matrix maps pixel space (v pointing down) to art space: art = (tx + a·u − c·v, ty + b·u − d·v).
Samples: interleaved color (w·h·channels) followed by one plane per alpha channel.

### Meshes

`X#` entries: `[3 3] /Size`, `/DeviceRGB /CS`, per patch `[row col] /P` and four `/N` corner
records `[color… x y hx1 hy1 1 hx2 hy2 1]` — the first handle points to the next corner, the
second to the previous one. Each patch is a Coons patch.

## 7. Text (`%AI11_BeginTextDocument`)

Two ASCII85 payloads: `/AI11TextDocument` (with `Rx Ry /RulerOrigin`) and
`/AI11UndoFreeTextDocument`. **Text objects with `/FreeUndo 1` (the copies inside appearance
results) index stories/frames in the second document.**

Payload syntax: Photoshop-EngineData-like with **numeric keys** ("Txt2"). Strings are UTF-16BE with BOM.
Recovered keys:

| path | meaning |
|---|---|
| `/0/1/0[i]/0/0/0` | font PostScript name (`/0/2` type, `/0/5` version) |
| `/0/5/0`, `/0/6/0` | character / paragraph style sheets |
| `/0/8/0[i]/0` | text frame: `/0 [x y]` anchor, `/2/2 [a b c d tx ty]` matrix, `/97` uuid |
| `/1/2`, `/1/3` | default character / paragraph features |
| `/1/1[i]/0/0` | story text (`\r` = paragraph end) |
| `/1/1[i]/0/5`, `/0/6` | paragraph / character runs: `{ /0 {/0 {/5 or /6 features}} /1 length }` |
| `/1/1[i]/1/0` | frame ids showing the story |
| `/1/1[i]/1/2` | composed layout `PC > F(/10 frame) > R > R > L > S(/15/0 char count) > G` |
| `G /8`, `G /1` | glyph run bbox / extents (baseline = bbox − extents) |
| `G /21 /0`, `/21 /1` | glyph ids, x positions |

Character features: `/0` font index, `/1` size, `/2` faux bold, `/3` faux italic, `/4` auto
leading, `/5` leading *(inferred)*, `/6` `/7` horizontal / vertical scale, `/8` tracking (1/1000 em,
verified against glyph positions), `/9` baseline shift, `/53` fill paint, `/54` stroke paint,
`/56` `/57` fill / stroke enabled *(inferred)*, `/63` stroke width *(inferred)*.
Paint: `{ /99 /CAITextPaint /0 { /0 colorType /1 [alpha c1 c2 c3] } /5 (art style) }`.

Text space has y down: `art = (M·p).x − Rx, Ry − (M·p).y` with `M` the frame matrix and `R` the
ruler origin — verified exactly against PDF text positions ("CTO" at (482.56, 323.73) on page 7).

## 8. Known gaps

* Area text and text on a path frames are parsed generically but not modelled (no sample).
* Symbol instances, placed (linked) art, charts, Live Paint, blends: kept verbatim, not modelled.
* Meshes are read and rendered, but written back verbatim (geometry edits are not persisted).
* Writing uses `%AI24_ZStandard_Data` (one zstd frame, level 3, `RoundtripStreamType 2`) by
  default, or `%AI12_CompressedData` (zlib, `RoundtripStreamType 1`). **Reopening written files
  in Illustrator has not been verified** (Illustrator was not available).
* Edited text keeps Illustrator's cached composition; Illustrator is expected to recompose it.
