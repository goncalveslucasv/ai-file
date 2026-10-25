<div align="center">

# ai-file

**Read, edit and write Adobe Illustrator `.ai` files natively — in Node and the browser.**

[![CI](https://github.com/goncalveslucasv/ai-file/actions/workflows/ci.yml/badge.svg)](https://github.com/goncalveslucasv/ai-file/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)
![Runtime deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)
![Rust + WebAssembly](https://img.shields.io/badge/codecs-Rust%20%2B%20WebAssembly-dea584?logo=rust&logoColor=white)
![Node](https://img.shields.io/badge/node-%E2%89%A522.18-339933?logo=node.js&logoColor=white)

[Quick start](#quick-start) · [Recipes](#recipes) · [API](#api) · [Performance](#performance) · [How it works](#how-it-works) · [Format spec](docs/FORMAT.md) · [Status](#status)

</div>

---

Every other tool opens an `.ai` file through its **PDF preview**: a flattened picture of the
artwork with no layers, no editable text, no live appearances and no way to save back.

`ai-file` decodes **Illustrator's own private data** — the compressed native stream that
Illustrator itself reads — so you get the document the way the designer built it, and you can
write it back.

```ts
import { readAiFile, renderArtboardSvg } from "ai-file";

const { document } = await readAiFile(file);       // File, Blob, ArrayBuffer or Uint8Array

document.artboards;                                 // 8 artboards, names and bounds
document.layers;                                    // layers → groups → clip groups → paths…
document.text?.stories.map((s) => s.text);          // real, editable text with fonts and runs

const svg = renderArtboardSvg(document, 0);         // high-fidelity SVG of artboard 1
```

## Highlights

- 🧬 **Native, not a preview.** Parses the AI24 (zstd), AI12 (zlib) and plain native streams
  embedded in PDF-compatible `.ai` files, plus legacy EPS-style files.
- 🌳 **The real object tree.** Layers, groups, clip groups, compound paths, Bézier paths,
  gradients (linear/radial, with midpoints and opacity stops), gradient meshes, embedded images
  with alpha, swatches, symbols, art styles, artboards.
- 🔤 **Real text.** Stories, paragraphs and character runs with font, size, tracking, leading,
  fill and stroke, positioned exactly where Illustrator puts them.
- 🎭 **Live appearances preserved.** Effects are stored by Illustrator as *expanded result +
  hidden editable source*; both are exposed (`art.source`) and round-tripped.
- ✏️ **Edit and save.** Move, transform, recolor, change opacity, replace text, insert or remove
  objects, create documents from scratch — then write a valid `.ai` file.
- 🔁 **Lossless round-trip.** Untouched objects are copied byte-for-byte; an unedited document
  serializes **byte-identical**. Only what you change is regenerated.
- 🖼️ **Rendering built in.** Artboard → SVG (gradients, masks, blend modes, meshes, images,
  text), raster → PNG, and a fresh PDF preview when saving.
- ⚡ **Fast.** Opens a 647 MB file (1 GB native stream) in **1.5 s**, renders all its
  artboards in **0.6 s** and re-saves it unchanged in **0.5 s**. [Numbers below](#performance).
- 🦀 **Rust + WebAssembly where it counts.** Compression and pixel work run in a single
  embedded WebAssembly module built from battle-tested libraries: the reference
  [`libzstd`](https://github.com/facebook/zstd), [`zlib-rs`](https://github.com/trifectatechfoundation/zlib-rs)
  and the [`png`](https://github.com/image-rs/image-png) crate. Data streams through it in
  chunks, so a 1 GB payload never has to fit in wasm memory.
- 🌐 **Universal, zero dependencies.** Strict TypeScript, ESM. The same build runs in Node,
  browsers, workers and bundlers — no native addons, no `.wasm` file to serve, no async init
  required.
- 📖 **Documented format.** The reverse-engineered specification lives in
  [`docs/FORMAT.md`](docs/FORMAT.md).

## Install

```sh
npm install github:goncalveslucasv/ai-file
```

The package builds itself on install (`prepare`); the WebAssembly module ships prebuilt, so no
Rust toolchain is needed to use it. Requires Node ≥ 22.18 for development (native TypeScript);
the built output runs in any modern browser or bundler.

## Quick start

```ts
import fs from "node:fs";
import {
  readAiBytes, saveAiFile, renderArtboardSvg,
  findArt, setText, translateArt, setFillColor, insertArt, createRect, rgb,
} from "ai-file";

// 1. Read
const { container, document: doc } = readAiBytes(fs.readFileSync("card.ai"));

// 2. Inspect
console.log(doc.artboards.map((a) => a.name));
console.log(doc.text?.fonts.map((f) => f.postScriptName));

// 3. Edit
const name = findArt(doc, (a) => a.type === "text");
if (name) {
  setText(doc, name, "Lucía Fernández");
  translateArt(doc, name, 0, 12);
}
const badge = createRect(40, -40, 120, 32, { fill: { type: "color", color: rgb(0.1, 0.6, 0.3) } });
insertArt(doc.layers[0], badge);
setFillColor(badge, rgb(0.9, 0.2, 0.2));

// 4. Save — a real .ai file, reopenable by this library (and meant for Illustrator)
fs.writeFileSync("card-edited.ai", saveAiFile(doc, container, { rendition: "generate" }));

// 5. Render
fs.writeFileSync("artboard-1.svg", renderArtboardSvg(doc, 0));
```

## Recipes

<details>
<summary><b>Open a file in the browser</b></summary>

```ts
import { readAiFile, renderArtboardSvg } from "ai-file";

input.addEventListener("change", async () => {
  const { document } = await readAiFile(input.files![0], {
    onProgress: (done, total) => (progress.value = done / total),
  });
  preview.innerHTML = renderArtboardSvg(document, 0);
});
```
</details>

<details>
<summary><b>Walk the object tree</b></summary>

```ts
import { walk } from "ai-file";

walk(doc, (art, parent, depth) => {
  console.log("  ".repeat(depth) + art.type, art.type === "path" ? art.style.fill : "");
});

// Pass `true` to also visit the hidden editable sources of live appearances.
walk(doc, (art) => { /* … */ }, true);
```
</details>

<details>
<summary><b>Read text with styling</b></summary>

```ts
for (const story of doc.text?.stories ?? []) {
  for (const run of story.chars) {
    const chunk = story.text.slice(run.start, run.start + run.length);
    console.log(JSON.stringify(chunk), run.style.font?.postScriptName, run.style.size, run.style.fill);
  }
}
```
</details>

<details>
<summary><b>Export embedded images as PNG</b></summary>

```ts
import { walk, rasterToRgba, encodePng } from "ai-file";

let i = 0;
walk(doc, (art) => {
  if (art.type !== "raster") return;
  const img = rasterToRgba(art, doc.source);      // color + alpha planes → RGBA
  if (img) fs.writeFileSync(`image-${i++}.png`, encodePng(img.rgba, img.width, img.height));
});
```
</details>

<details>
<summary><b>Create a document from scratch</b></summary>

```ts
import { createDocument, insertArt, createEllipse, createGroup, saveAiFile, rgb } from "ai-file";

const doc = createDocument({
  artboards: [{ name: "Front", width: 252, height: 144 }, { name: "Back", width: 252, height: 144 }],
});
const logo = createGroup([
  createEllipse(126, -72, 40, 40, { fill: { type: "color", color: rgb(0, 0, 0) } }),
]);
insertArt(doc.layers[0], logo);

fs.writeFileSync("new.ai", saveAiFile(doc));
```
</details>

<details>
<summary><b>Dump the raw native stream</b></summary>

```ts
import { openAiContainer, lex } from "ai-file";

const c = openAiContainer(bytes);
console.log(c.compression, c.privateInfo);      // "zstd", { ContainerVersion: 12, … }
for (const st of lex(c.stream).slice(0, 50)) console.log(st.hidden ? "%_" : "  ", st.op, st.args);
```
</details>

## API

### Reading

| Function | Description |
|---|---|
| `readAiFile(input, options?)` | Async. Accepts `Blob` / `File` / `ArrayBuffer` / `Uint8Array`. Returns `{ container, document }`. |
| `readAiBytes(bytes, options?)` | Sync variant for bytes already in memory. |
| `openAiContainer(bytes)` | Container layer only: PDF objects, private-data blocks, decompressed native stream. |
| `parseAiStream(stream)` | Native stream → `AiDocument`. |
| `looksLikeAi(head)` | Sniffs the first bytes of a file. |

Options: `onProgress(done, total)` during decompression, `skipText` to skip the text engine.

The WebAssembly codecs instantiate synchronously on first use. `readAiFile` (and an optional
`await initWasm()`) compile them asynchronously instead, which keeps a browser's main thread free.

### The document model

```ts
interface AiDocument {
  header: AiHeader;                     // creator, version, bounding box…
  artboards: Artboard[];                // { name, left, top, right, bottom } — art space, y up
  layers: LayerArt[];                   // the object tree
  swatches: Swatch[];
  gradients: Map<string, GradientDef>;
  patterns: Map<string, PatternDef>;
  symbols: Map<string, SymbolDef>;
  artStyles: Map<string, ArtStyle>;
  text?: TextDocument;                  // stories, frames, fonts, styles
  documentData?: DictNode;              // raw document dictionary
  warnings: string[];
}

type Art = LayerArt | GroupArt | PathArt | CompoundPathArt | RasterArt | TextArt | MeshArt | UnknownArt;
```

Every art node carries its `style` (fill, stroke, dash, blend mode, opacity), optional `source`
(editable original of a live appearance) and anything the library does not model yet as
`UnknownArt` — kept verbatim, so it survives a save.

### Editing

| Function | Description |
|---|---|
| `walk(doc, fn, includeSources?)` · `findArt(doc, pred)` · `parentOf(doc, art)` | Traversal |
| `insertArt(parent, art, index?)` · `removeArt(doc, art)` | Structure |
| `transformArt(doc, art, matrix)` · `translateArt(doc, art, dx, dy)` | Geometry — paths, gradients, images and text frames |
| `setFillColor(art, color)` · `setStrokeColor(art, color, width?)` · `setOpacity(art, value)` | Appearance |
| `setText(doc, textArt, string)` | Replace the content of a text object |
| `createPath` · `createRect` · `createEllipse` · `createGroup` · `rgb(r, g, b)` | Factories |
| `createDocument({ artboards, gap, layerName, title })` | New empty document |

### Writing

```ts
saveAiFile(doc, container?, {
  rendition: "keep" | "generate",       // reuse the original PDF preview, or build a new one from the model
  compression: "zstd" | "deflate" | "none", // default: the original file's, else zstd (like Illustrator 2020+)
  compressionLevel: 3,                  // zstd 1-22 / deflate 0-9
  title: "Business card",
}): Uint8Array
```

If nothing was edited, the original compressed private data is reused as is — saving costs
little more than writing the file.

`serializeAiStream(doc)` returns just the native stream if you want to embed it yourself.

### Rendering

| Function | Description |
|---|---|
| `renderArtboardSvg(doc, index, { maxImageSize, imageLevel, preferSource, imageHref, meshSteps, background })` | Artboard → SVG string. Only art that touches the artboard is emitted; encoded images are cached per document. |
| `rasterToPng(art, doc.source, maxSize?)` · `rasterToRgba(…)` · `rasterToPlanes(…)` · `encodePng(rgba, w, h)` | Embedded images |
| `artBounds(art)` | Conservative bounding box in art space |
| `pathData(pathArt)` | Path → SVG `d` attribute |

### Low level

`lex` (tokenizer for the PostScript dialect), `parseDictBlock` / `writeDict` (Illustrator's
dictionary language), `parseTxt2` / `writeTxt2` (text engine payloads), `PdfReader`, and the
codecs themselves: `zstdDecompress` / `zstdCompress` / `inflate` / `deflate` (streaming, accept
a `Uint8Array` or any iterable of chunks).

## Performance

Measured on a 647 MB Illustrator 2026 document (8 artboards, 32 embedded images, 1 GB native
stream), Node 24, Apple Silicon:

| Operation | v0.1 (pure JS) | Now (Rust/WASM codecs) | |
|---|--:|--:|--:|
| Open + parse | 7.2 s | **1.5 s** | 4.8× |
| Render all 8 artboards to SVG | 30 s | **0.6 s** (0.07 s warm) | 50× |
| Save, unchanged | 18 s | **0.5 s** | 36× |
| Save, edited, keep PDF preview | 18 s | **5.9 s** | 3× |
| Save, edited, new PDF preview | 28 s | **11 s** | 2.5× |

Where the time goes: zstd decompression 1.3 s (fzstd took 6.8 s; native libzstd takes 1.1 s),
tokenizing + parsing 0.24 s, zstd level-3 compression 5 s. The SVG speed-up comes from
artboard culling and a per-document image cache, plus PNG encoding in Rust.

The parser stays in TypeScript on purpose: it is already ~0.2 s for 1 GB, and moving it into
WebAssembly would mean copying the whole stream into wasm memory (capped at 4 GB, and 64-bit
memory is not available in Safari) for almost no gain.

## How it works

```
 .ai file (PDF)
 ├── PDF pages ─────────────────────────── preview for other apps (what everyone else reads)
 └── /PieceInfo/Illustrator/Private
      ├── AIMetaData                        header comments
      └── AIPrivateData1 … N  (64 KB each)  ─┐
                                             │ concatenate, strip "%AI24_ZStandard_Data"
                                             ▼ zstd / zlib  (streaming, Rust → WebAssembly)
                          native stream  (PostScript dialect, ~1 GB in the sample)
                                             │
                    lex ─────────────────────┤  statements tile the source exactly
                                             ▼
          parse: graphics state machine, art grammar, dictionaries, Txt2 text engine
                                             │
                                             ▼
                                        AiDocument ──► edit ──► serialize (copy untouched
                                             │                  spans, regenerate dirty ones)
                                             ▼                          │
                                       SVG / PNG / PDF ◄────────────────┘ saveAiFile → .ai
```

Some of what had to be figured out (all in [`docs/FORMAT.md`](docs/FORMAT.md)):

- Anything after `%_` is **Illustrator-only** content that a PostScript RIP skips — about 40%
  of the artwork, including every editable source of a live effect.
- `%%BeginData: N` **under-reports** its length for images with alpha: the alpha plane is
  written but not counted.
- A clip group's clipping path is written **last**, not first.
- Gradient geometry is the unit vector mapped through `Xm`; midpoints are exponent curves.
- Text uses a Photoshop-EngineData-like format with **numeric keys**; text space is y-down and
  offset by the ruler origin. Copies of text inside expanded appearances index a *second* text
  document.

Every interpretation was checked against the PDF rendition Illustrator stores in the same file:
positions, colors, gradient vectors, fonts and text baselines match.

## Status

| Feature | Read | Render | Write |
|---|:-:|:-:|:-:|
| Layers, groups, clip groups, compound paths, paths | ✅ | ✅ | ✅ |
| Solid colors (RGB, CMYK, gray, spot/global) | ✅ | ✅ | ✅ |
| Strokes, dashes, blend modes, opacity | ✅ | ✅ | ✅ |
| Linear & radial gradients | ✅ | ✅ | ✅ |
| Embedded images (with alpha) | ✅ | ✅ | ✅ |
| Live appearances (result + editable source) | ✅ | ✅ | ✅ |
| Point text (stories, runs, fonts, frames) | ✅ | ✅ | ✅ |
| Gradient meshes | ✅ | ✅ | ⚪ verbatim |
| Artboards, swatches, symbols, art styles | ✅ | — | ⚪ verbatim |
| Area text, text on a path | ⚪ raw | ❌ | ⚪ verbatim |
| Symbol instances, linked art, Live Paint, blends, charts | ⚪ raw | ❌ | ⚪ verbatim |

⚪ = preserved untouched through a save, but not editable through the model yet.

**Validation.** Developed against a 647 MB Illustrator 2026 (v30) document with 8 artboards,
17 gradients, meshes, alpha images, 24 text stories and live effects:

- parses with 0 warnings; SVG renderings match Illustrator's own PDF rendition;
- unedited save is byte-identical; regenerating *every* object reproduces an identical model and
  identical renderings;
- edited files reopen cleanly and their generated PDF previews render in macOS PDFKit;
- the WebAssembly build runs in Chrome (synchronous and asynchronous instantiation).

**Not yet verified:** reopening written files in Illustrator itself. Saving writes
`%AI24_ZStandard_Data` (a single zstd frame, like Illustrator 2020+) by default, or
`%AI12_CompressedData` (zlib) on request. If you try it, please
[open an issue](https://github.com/goncalveslucasv/ai-file/issues) with the result.

## CLI

```sh
node scripts/ai-inspect.ts file.ai                  # summary + object tree
node scripts/ai-inspect.ts file.ai --svg out/       # one SVG per artboard
node scripts/ai-inspect.ts file.ai --stream raw.txt # dump the decompressed native stream
node --max-old-space-size=12000 scripts/demo-edit.ts file.ai out/   # end-to-end edit demo
```

## Development

```sh
npm install
npm test                                  # unit + fixture tests
AI_SAMPLE=/path/to/file.ai npm test       # + parse/render/regenerate check on a real file
npm run typecheck
npm run build                             # → dist/
```

The source runs directly on Node's native TypeScript support — no build step for tests or scripts.

### The WebAssembly codecs

The Rust crate lives in [`wasm/`](wasm/src/lib.rs) and is embedded into
`src/wasm/binary.ts`, which is committed — you only need Rust to change it:

```sh
rustup target add wasm32-unknown-unknown
# libzstd is C: point to a clang that targets wasm32, e.g. a wasi-sdk install
WASI_SDK_PATH=/path/to/wasi-sdk npm run build:wasm
```

The module has a tiny C ABI (no wasm-bindgen): codecs pull input through an imported
`js_read` and push output through `js_write`, so JavaScript owns every large buffer.

## Roadmap

- [ ] Verify round-trip in Illustrator; collect a corpus of files across versions (CS6 → 2026)
- [x] zstd encoding for `%AI24_ZStandard_Data`
- [ ] Parse and render in a Web Worker with transferable buffers
- [ ] Area text and text on a path
- [ ] Symbol instances and placed (linked) art
- [ ] Editable meshes
- [ ] Rich text editing (per-run style changes)

## Contributing

Issues and PRs are welcome. The most valuable contribution is a **sample file**: if something
parses wrong, a minimal `.ai` that reproduces it (and a screenshot from Illustrator) makes it
fixable. Please don't attach files you don't have the rights to share.

## Acknowledgments

The initial binary map of the container was made with [REA](https://github.com/morluto/rea)'s
byte-entropy analysis. Codecs: [zstd](https://github.com/facebook/zstd) via
[zstd-rs](https://github.com/gyscos/zstd-rs), [zlib-rs](https://github.com/trifectatechfoundation/zlib-rs),
[image-png](https://github.com/image-rs/image-png). Format knowledge builds on Adobe's public *Adobe Illustrator File Format
Specification* (AI 3/7), extended here up to the AI24 stream.

## License

[MIT](LICENSE) © Lucas Goncalves

<sub>Adobe and Illustrator are trademarks of Adobe Inc. This project is not affiliated with or
endorsed by Adobe. It is an independent implementation for interoperability.</sub>
