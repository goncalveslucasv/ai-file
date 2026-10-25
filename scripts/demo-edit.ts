// End-to-end demo: read an .ai, edit it natively, save it, read it back and render previews.
//   node --max-old-space-size=12000 scripts/demo-edit.ts input.ai out-dir
import fs from "node:fs";
import path from "node:path";
import { createRect, findArt, insertArt, readAiBytes, renderArtboardSvg, rgb, saveAiFile, setFillColor, setText, translateArt } from "../src/index.ts";

const [input, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const t0 = performance.now();
const { container, document: doc } = readAiBytes(new Uint8Array(fs.readFileSync(input)));
console.log(`read in ${(performance.now() - t0) | 0} ms: ${doc.artboards.length} artboards, ${doc.layers.length} layers`);

// 1) Change a name (visible result copy and its editable source).
const ab = doc.artboards[0];
const ivana = findArt(doc, (a) => a.type === "text" && (a.undoFree ? doc.undoFreeText : doc.text)?.stories[a.storyIndex]?.text.startsWith("Ivana Sol Vigilante") === true);
if (ivana) setText(doc, ivana, "Lucía Fernández");
// 2) Add a red rectangle on the first artboard.
const rect = createRect(ab.left + 40, ab.top - 40, 120, 60, { fill: { type: "color", color: rgb(0.9, 0.1, 0.1) } });
insertArt(doc.layers[0], rect);
// 3) Recolor + move it.
setFillColor(rect, rgb(0.95, 0.6, 0.1));
translateArt(doc, rect, 20, -20);

for (const rendition of ["keep", "generate"] as const) {
  const t1 = performance.now();
  const out = saveAiFile(doc, container, { rendition, compressionLevel: 1 });
  const file = path.join(outDir, `edited-${rendition}.ai`);
  fs.writeFileSync(file, out);
  console.log(`saved ${file}: ${(out.length / 1e6).toFixed(1)} MB in ${(performance.now() - t1) | 0} ms`);
  const back = readAiBytes(out);
  console.log("  reopened:", back.container.compression, back.document.warnings.length, "warnings");
  fs.writeFileSync(path.join(outDir, `edited-${rendition}-ab0.svg`), renderArtboardSvg(back.document, 0, { maxImageSize: 1024 }));
}
