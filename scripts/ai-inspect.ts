// Inspect an .ai file natively:
//   node scripts/ai-inspect.ts file.ai                 summary + art tree
//   node scripts/ai-inspect.ts file.ai --svg out-dir   also writes one SVG per artboard
//   node scripts/ai-inspect.ts file.ai --stream out.txt dumps the decompressed native stream
import fs from "node:fs";
import path from "node:path";
import { readAiBytes, renderArtboardSvg, walk, type Art } from "../src/index.ts";

const [file, ...rest] = process.argv.slice(2);
if (!file) {
  console.error("usage: ai-inspect <file.ai> [--svg dir] [--stream out] [--depth n]");
  process.exit(1);
}
const opt = (k: string): string | undefined => {
  const i = rest.indexOf(k);
  return i >= 0 ? rest[i + 1] : undefined;
};
const t0 = performance.now();
const { container: c, document: doc } = readAiBytes(new Uint8Array(fs.readFileSync(file)));
console.log(`${path.basename(file)} — ${c.format}, private data ${c.compression}, ${(c.stream.length / 1e6).toFixed(1)} MB native stream, parsed in ${(performance.now() - t0) | 0} ms`);
console.log(`creator: ${doc.header.creator} (${doc.header.creatorVersion}), format ${doc.header.fileFormat}`);
console.log(`artboards: ${doc.artboards.map((a) => `${a.name} ${(a.right - a.left).toFixed(1)}x${(a.top - a.bottom).toFixed(1)}`).join(" | ")}`);
console.log(`swatches ${doc.swatches.length}, gradients ${doc.gradients.size}, patterns ${doc.patterns.size}, symbols ${doc.symbols.size}, art styles ${doc.artStyles.size}`);
if (doc.text) console.log(`fonts: ${doc.text.fonts.map((f) => f.postScriptName).join(", ")}; stories: ${doc.text.stories.length}`);
if (doc.warnings.length) console.log("warnings:", doc.warnings);
const depth = Number(opt("--depth") ?? 4);
const label = (a: Art): string => {
  switch (a.type) {
    case "layer": return `layer "${a.layerName}"`;
    case "group": return a.clipGroup ? "clip group" : "group";
    case "path": return `path ${a.segments.length} pts${a.clip ? " (clip)" : ""}`;
    case "raster": return `raster ${a.width}x${a.height}${a.alphaChannels ? "+alpha" : ""} ${a.file ? path.basename(a.file) : "(embedded)"}`;
    case "text": {
      const td = a.undoFree ? doc.undoFreeText : doc.text;
      return `text "${td?.stories[a.storyIndex]?.text.trim().slice(0, 40)}"`;
    }
    default: return a.type;
  }
};
walk(doc, (a, _p, d) => {
  if (d > depth) return false;
  console.log("  ".repeat(d) + label(a) + (a.source ? `  [appearance "${a.sourceStyle}", editable source kept]` : "") + (a.illustratorOnly ? "  (Illustrator-only)" : ""));
});
const svgDir = opt("--svg");
if (svgDir) {
  fs.mkdirSync(svgDir, { recursive: true });
  doc.artboards.forEach((ab, i) => fs.writeFileSync(path.join(svgDir, `artboard-${i + 1}.svg`), renderArtboardSvg(doc, i, { maxImageSize: 2048 })));
  console.log(`wrote ${doc.artboards.length} SVG files to ${svgDir}`);
}
const streamOut = opt("--stream");
if (streamOut) fs.writeFileSync(streamOut, c.stream);
