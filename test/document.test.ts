import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAiStream } from "../src/parse/document.ts";
import type { GroupArt, PathArt, RasterArt } from "../src/model/types.ts";
import { renderArtboardSvg } from "../src/render/svg.ts";
import { rasterToRgba } from "../src/render/png.ts";
import { fixtureBytes } from "./fixture.ts";

const doc = parseAiStream(fixtureBytes());
const layer = doc.layers[0];

test("header, artboards and gradients", () => {
  assert.equal(doc.warnings.length, 0, doc.warnings.join("\n"));
  assert.deepEqual(doc.artboards.map((a) => [a.name, a.left, a.top, a.right, a.bottom]), [["Board", 0, 200, 300, 0]]);
  const g = doc.gradients.get("Fade")!;
  assert.equal(g.type, "linear");
  assert.deepEqual(g.stops.map((s) => [s.offset, s.opacity]), [[0, 0], [1, 1]]);
});

test("layer tree", () => {
  assert.equal(layer.layerName, "Capa");
  assert.deepEqual(layer.children.map((c) => c.type + (c.type === "group" && c.clipGroup ? "(clip)" : "")), ["group", "group(clip)", "group", "raster"]);
});

test("sticky graphics state: second path inherits the red fill", () => {
  const g = layer.children[0] as GroupArt;
  const [a, b] = g.children as PathArt[];
  assert.equal(a.name, "red_square");
  assert.deepEqual(b.style.fill, a.style.fill);
  assert.equal(b.segments[2].smooth, true);
});

test("clip group: clip path last, compound path with directions", () => {
  const q = layer.children[1] as GroupArt;
  const [compound, clip] = q.children;
  assert.equal(compound.type, "compound");
  assert.equal((clip as PathArt).clip, true);
  if (compound.type === "compound") assert.deepEqual(compound.children.map((p) => p.reversed), [true, false]);
});

test("appearance result + hidden editable source", () => {
  const styled = layer.children[2] as GroupArt;
  assert.equal(styled.blend?.mode, "multiply");
  assert.equal(styled.blend?.opacity, 0.5);
  assert.equal(styled.sourceStyle, "Anon Style");
  assert.equal(styled.source?.length, 1);
  assert.equal(styled.source?.[0].illustratorOnly, true);
  const path = styled.children[0] as PathArt;
  assert.equal(path.style.fill?.type, "gradient");
});

test("raster with alpha plane", () => {
  const r = layer.children[3] as RasterArt;
  assert.deepEqual([r.width, r.height, r.channels, r.alphaChannels], [2, 2, 3, 1]);
  const img = rasterToRgba(r, doc.source)!;
  assert.deepEqual([...img.rgba.subarray(0, 8)], [255, 0, 0, 255, 0, 255, 0, 128]);
});

test("svg rendering", () => {
  const svg = renderArtboardSvg(doc, 0);
  assert.match(svg, /<linearGradient/);
  assert.match(svg, /clip-path=/);
  assert.match(svg, /mix-blend-mode:multiply/);
  assert.match(svg, /data:image\/png;base64/);
});
