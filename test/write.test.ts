import assert from "node:assert/strict";
import { test } from "node:test";
import { openAiContainer } from "../src/container/ai.ts";
import { createDocument } from "../src/create.ts";
import { createEllipse, createRect, insertArt, rgb, setFillColor, translateArt } from "../src/edit.ts";
import type { GroupArt, PathArt } from "../src/model/types.ts";
import { parseAiStream } from "../src/parse/document.ts";
import { renderArtboardSvg } from "../src/render/svg.ts";
import { decodeAscii85, encodeAscii85, parseDictBlock, writeDict } from "../src/syntax/dict.ts";
import { lex } from "../src/syntax/lexer.ts";
import { parseTxt2, writeTxt2 } from "../src/text/txt2.ts";
import { fromLatin1 } from "../src/bytes.ts";
import { saveAiFile } from "../src/write/aifile.ts";
import { serializeAiStream } from "../src/write/stream.ts";
import { docSignature, firstDiff } from "./compare.ts";
import { fixtureBytes } from "./fixture.ts";

test("unmodified documents serialize byte-identical", () => {
  const src = fixtureBytes();
  assert.equal(serializeAiStream(parseAiStream(src)), src);
});

test("full regeneration preserves the model and the rendering", () => {
  const doc = parseAiStream(fixtureBytes());
  const out = serializeAiStream(doc, { regenerate: true });
  const back = parseAiStream(out);
  assert.equal(back.warnings.length, 0, back.warnings.join("\n"));
  assert.equal(firstDiff(docSignature(doc), docSignature(back)), null);
  assert.equal(renderArtboardSvg(back, 0), renderArtboardSvg(doc, 0));
});

test("editing one object keeps the inherited state of copied neighbours", () => {
  const doc = parseAiStream(fixtureBytes());
  const g = doc.layers[0].children[0] as GroupArt;
  const [first, second] = g.children as PathArt[];
  const originalFill = structuredClone(second.style.fill);
  setFillColor(first, rgb(0, 0, 1));
  const back = parseAiStream(serializeAiStream(doc));
  const [b1, b2] = (back.layers[0].children[0] as GroupArt).children as PathArt[];
  assert.deepEqual(b1.style.fill, { type: "color", color: { kind: "rgb", r: 0, g: 0, b: 1, cmyk: [1, 1, 0, 0] } });
  assert.deepEqual(b2.style.fill, originalFill);
});

test("dictionary language round trip", () => {
  const text = "/ArtDictionary :\r/Dictionary : /NotRecorded ,\r1.5 /Real (w) ,\r(x) /UnicodeString (name) ,\r1 2 /RealPoint\r (p) ,\r; (inner) ,\r/XMLUID : (id_1) ; (AI10_ArtUID) ,\r;";
  const node = parseDictBlock(lex(fromLatin1(text)), 0).roots[0];
  const again = parseDictBlock(lex(fromLatin1(writeDict(node).join("\r"))), 0).roots[0];
  assert.deepEqual(again, node);
});

test("ascii85 and Txt2 round trips", () => {
  const data = Uint8Array.from({ length: 1000 }, (_, i) => (i * 37) % 256);
  assert.deepEqual(decodeAscii85(encodeAscii85(data)), data);
  const t2 = parseTxt2(fromLatin1(" /0 << /0 (\xfe\xff\x00H\x00i) /1 [ 1 .5 true /Name ] /2 (raw) >>"));
  assert.deepEqual(parseTxt2(fromLatin1(writeTxt2(t2))), t2);
});

test("new document -> .ai file -> read back", () => {
  const doc = createDocument({ artboards: [{ name: "A4", width: 595, height: 842 }], title: "Nuevo" });
  const rect = createRect(50, -50, 200, 100, { fill: { type: "color", color: rgb(1, 0, 0) } });
  const circle = createEllipse(300, -400, 80, 80, { fill: { type: "color", color: rgb(0, 0.5, 0) } });
  insertArt(doc.layers[0], rect);
  insertArt(doc.layers[0], circle);
  translateArt(doc, circle, 10, 0);
  for (const compression of ["zstd", "deflate", "none"] as const) {
    const bytes = saveAiFile(doc, undefined, { rendition: "generate", compression });
    const c = openAiContainer(bytes);
    assert.equal(c.format, "pdf");
    assert.equal(c.compression, compression);
    assert.equal(c.privateInfo?.roundtripStreamType, { zstd: 2, deflate: 1, none: 0 }[compression]);
    assert.equal(c.pageCount, 1);
    const back = parseAiStream(c.stream);
    assert.equal(back.warnings.length, 0, back.warnings.join("\n"));
    assert.deepEqual(back.artboards.map((a) => a.name), ["A4"]);
    const paths = back.layers[0].children as PathArt[];
    assert.equal(paths.length, 2);
    assert.deepEqual(paths[1].segments[0].x, 390);
  }
});

test("unchanged document reuses the compressed private data", () => {
  const doc = createDocument({ artboards: [{ width: 100, height: 100 }] });
  const first = saveAiFile(doc, undefined, { compression: "deflate" });
  const c = openAiContainer(first);
  const again = parseAiStream(c.stream);
  const second = openAiContainer(saveAiFile(again, c, { rendition: "generate" }));
  assert.equal(second.compression, "deflate");
  assert.deepEqual(second.privateBlocks, c.privateBlocks);
});
