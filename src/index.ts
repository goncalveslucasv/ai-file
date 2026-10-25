// ai-file — native reader/writer for Adobe Illustrator (.ai) files.
//
//   const file = await readAiFile(blobOrBytes);
//   file.document.layers / artboards / text ...
//   renderArtboardSvg(file.document, 0);
//   setText(file.document, someTextArt, "Hola");
//   const bytes = saveAiFile(file.document, file.container);

import { openAiContainer, type AiContainer, type OpenOptions } from "./container/ai.ts";
import type { AiDocument } from "./model/types.ts";
import { parseAiStream, type ParseOptions } from "./parse/document.ts";
import { initWasm } from "./wasm/codec.ts";

export interface AiFile {
  container: AiContainer;
  document: AiDocument;
}

export type ReadOptions = OpenOptions & ParseOptions;

/** Reads and parses an .ai file held in memory. */
export function readAiBytes(bytes: Uint8Array, options: ReadOptions = {}): AiFile {
  const container = openAiContainer(bytes, options);
  return { container, document: parseAiStream(container.stream, options) };
}

/** Reads and parses an .ai file from bytes, an ArrayBuffer or a Blob/File (browser). */
export async function readAiFile(input: Uint8Array | ArrayBuffer | Blob, options: ReadOptions = {}): Promise<AiFile> {
  const ready = initWasm();
  let bytes: Uint8Array;
  if (input instanceof Uint8Array) bytes = input;
  else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
  else bytes = new Uint8Array(await input.arrayBuffer());
  await ready;
  return readAiBytes(bytes, options);
}

export * from "./model/types.ts";
export { colorCss, toRgb, cmykToRgb } from "./model/color.ts";
export { openAiContainer, decodePrivateBlocks, looksLikeAi, type AiContainer, type AiCompression } from "./container/ai.ts";
export { PdfReader } from "./container/pdf.ts";
export { parseAiStream } from "./parse/document.ts";
export { lex, type Statement, type Operand } from "./syntax/lexer.ts";
export { parseDictBlock, dictToJson, getValue, findEntry, findEntryDeep, writeDict, type DictNode, type DictEntry } from "./syntax/dict.ts";
export { parseTxt2, writeTxt2, readTextDocument, textToArt, setStoryText, type TextDocument, type TextStory, type TextFrame, type TextLine, type CharStyle, type ParagraphStyle } from "./text/txt2.ts";
export { renderArtboardSvg, pathData, fontInfo, type SvgOptions } from "./render/svg.ts";
export { encodePng, rasterToRgba, rasterToPng, rasterToPlanes } from "./render/png.ts";
export { artBounds, intersects, type Bounds } from "./model/bounds.ts";
export { initWasm, zstdDecompress, zstdCompress, deflate, inflate, type CodecOptions } from "./wasm/codec.ts";
export { serializeAiStream, type SerializeOptions } from "./write/stream.ts";
export { saveAiFile, encodePrivateData, type SaveOptions } from "./write/aifile.ts";
export * from "./edit.ts";
export { createDocument, emptyStreamText, type NewDocumentOptions } from "./create.ts";
