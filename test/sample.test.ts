// Integration test against a real Illustrator file: AI_SAMPLE=/path/file.ai npm test
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { readAiBytes } from "../src/index.ts";
import { renderArtboardSvg } from "../src/render/svg.ts";
import { parseAiStream } from "../src/parse/document.ts";
import { serializeAiStream } from "../src/write/stream.ts";
import { docSignature, firstDiff } from "./compare.ts";

const sample = process.env.AI_SAMPLE;

test("real file: parse, render, regenerate", { skip: !sample }, () => {
  const { document: doc } = readAiBytes(new Uint8Array(fs.readFileSync(sample!)));
  assert.equal(doc.warnings.length, 0, doc.warnings.join("\n"));
  assert.ok(doc.artboards.length > 0);
  assert.equal(serializeAiStream(doc), doc.source);
  const back = parseAiStream(serializeAiStream(doc, { regenerate: true }));
  assert.equal(firstDiff(docSignature(doc), docSignature(back)), null);
  for (let i = 0; i < doc.artboards.length; i++) {
    assert.equal(renderArtboardSvg(back, i, { maxImageSize: 32 }), renderArtboardSvg(doc, i, { maxImageSize: 32 }));
  }
});
