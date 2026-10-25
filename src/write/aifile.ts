// Writes complete .ai files: a PDF whose first page carries the Illustrator private data.
//
// Two strategies for the PDF part:
//  - "keep": copy every object of the original PDF rendition verbatim and only replace the
//    private data (fast; the rendition shows the document as it was before editing).
//  - "generate": build a new rendition from the model (one page per artboard).
//
// The native stream is stored zstd-compressed with the "%AI24_ZStandard_Data" tag (as Illustrator
// 2020+ writes it) or deflate-compressed with "%AI12_CompressedData", split in 64 KiB blocks like
// Illustrator does. When the stream did not change, the original compressed blocks are reused.

import { concatBytes, fromLatin1, indexOf, latin1 } from "../bytes.ts";
import type { AiCompression, AiContainer } from "../container/ai.ts";
import { deflate, zstdCompress } from "../wasm/codec.ts";
import { isRef, isStream, type PdfReader } from "../container/pdf.ts";
import type { AiDocument } from "../model/types.ts";
import { PdfBuilder, name, ref, raw, type PVal } from "./pdfobj.ts";
import { RenditionBuilder, type RenditionOptions } from "./rendition.ts";
import { serializeAiStream, type SerializeOptions } from "./stream.ts";

export interface SaveOptions extends SerializeOptions, RenditionOptions {
  /** PDF rendition strategy (default: "keep" when the original container is a PDF, else "generate"). */
  rendition?: "keep" | "generate";
  /** Private data compression (default: the original file's, else "zstd"). */
  compression?: AiCompression;
  /** Compression level: zstd 1-22 (default 3), deflate 0-9 (default 6). */
  compressionLevel?: number;
  /** Size of each AIPrivateData block (default 65536). */
  blockSize?: number;
  /** Document title stored in the PDF Info dictionary. */
  title?: string;
}

const BLOCK = 65536;

const TAGS: Record<Exclude<AiCompression, "none">, string> = { zstd: "%AI24_ZStandard_Data", deflate: "%AI12_CompressedData" };

/** Splits and (optionally) compresses the native stream into AIPrivateData blocks. */
export function encodePrivateData(stream: Uint8Array | Uint8Array[], opts: SaveOptions = {}): Uint8Array[] {
  const parts = Array.isArray(stream) ? stream : [stream];
  const block = opts.blockSize ?? BLOCK;
  const compression = opts.compression ?? "zstd";
  let payload: Uint8Array;
  if (compression === "none") {
    payload = parts.length === 1 ? parts[0] : concatBytes(parts);
  } else {
    const tag = fromLatin1(TAGS[compression]);
    const body = compression === "zstd" ? zstdCompress(parts, opts.compressionLevel ?? 3) : deflate(parts, opts.compressionLevel ?? 6);
    payload = concatBytes([tag, body]);
  }
  const blocks: Uint8Array[] = [];
  for (let o = 0; o < payload.length; o += block) blocks.push(payload.subarray(o, Math.min(payload.length, o + block)));
  if (!blocks.length) blocks.push(new Uint8Array(0));
  return blocks;
}

/** The %!PS header part of the native stream (up to %%EndComments), used as AIMetaData. */
function headerOf(stream: Uint8Array): Uint8Array {
  const e = indexOf(stream, "%%EndComments", 0, Math.min(stream.length, 1 << 20));
  if (e < 0) return stream.subarray(0, Math.min(stream.length, 4096));
  let end = e + "%%EndComments".length;
  while (stream[end] === 0x0d || stream[end] === 0x0a) end++;
  return stream.subarray(0, end);
}

function writePrivate(pdf: PdfBuilder, privNum: number, blocks: Uint8Array[], meta: Uint8Array, info: { creatorVersion?: number; roundtripVersion?: number }, compression: string): void {
  const dict: Record<string, PVal> = {};
  const metaNum = pdf.alloc();
  pdf.stream(metaNum, {}, meta);
  dict.AIMetaData = ref(metaNum);
  blocks.forEach((b, i) => {
    const num = pdf.alloc();
    pdf.stream(num, {}, b);
    dict[`AIPrivateData${i + 1}`] = ref(num);
  });
  dict.ContainerVersion = 12;
  dict.CreatorVersion = info.creatorVersion ?? 30;
  dict.NumBlock = blocks.length;
  dict.RoundtripStreamType = compression === "zstd" ? 2 : compression === "deflate" ? 1 : 0;
  dict.RoundtripVersion = info.roundtripVersion ?? 24;
  pdf.object(privNum, dict);
}

function pdfDate(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? "+" : "-";
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${sign}${p(Math.floor(Math.abs(tz) / 60))}'${p(Math.abs(tz) % 60)}'`;
}

/**
 * Saves `doc` as a .ai file. Pass the container the document was read from to keep its PDF
 * rendition ("keep"), or omit it to generate a fresh one.
 */
export function saveAiFile(doc: AiDocument, container?: AiContainer, options: SaveOptions = {}): Uint8Array {
  const stream = serializeAiStream(doc, options);
  const original = container?.compression;
  const compression = options.compression ?? (original === "deflate" || original === "zstd" ? original : "zstd");
  // An unchanged stream (serializeAiStream returns the source itself) keeps its compressed blocks.
  const reuse = stream === container?.stream && container.privateBlocks && compression === original && options.compressionLevel === undefined && options.blockSize === undefined;
  const blocks = reuse ? container.privateBlocks! : encodePrivateData(stream, { ...options, compression });
  options = { ...options, compression };
  const meta = container?.metadata ?? headerOf(stream);
  const strategy = options.rendition ?? (container?.pdf ? "keep" : "generate");
  if (strategy === "keep" && container?.pdf && container.privateInfo?.privateObject !== undefined) {
    return keepRendition(container.pdf, container.privateInfo.privateObject, blocks, meta, container, options);
  }
  return generateRendition(doc, blocks, meta, options, container);
}

function keepRendition(src: PdfReader, privNum: number, blocks: Uint8Array[], meta: Uint8Array, c: AiContainer, options: SaveOptions): Uint8Array {
  // Objects referenced by the old private dictionary are dropped.
  const old = src.get(privNum);
  const drop = new Set<number>([privNum]);
  if (old instanceof Map) for (const v of old.values()) if (isRef(v)) drop.add(v.num);
  const hasCompressed = [...src.xref.values()].some((e) => e.type === 2);
  if (hasCompressed) throw new Error("Keeping a rendition that uses object streams is not supported; save with rendition: \"generate\".");
  const maxNum = Math.max(...src.xref.keys());
  const version = /%PDF-\d\.\d/.exec(latin1(src.bytes, 0, 32))?.[0] ?? "%PDF-1.6";
  const pdf = new PdfBuilder(maxNum + 1, `${version}\r%\xe2\xe3\xcf\xd3\r\n`);
  for (const [num, e] of [...src.xref.entries()].sort((a, b) => a[1].a - b[1].a)) {
    if (e.type !== 1 || e.a < 0 || drop.has(num)) continue;
    const endobj = indexOf(src.bytes, "endobj", e.a);
    let end = endobj + 6;
    // A stream may contain "endobj": make sure we skip past endstream first.
    const value = src.get(num);
    if (isStream(value)) {
      const es = indexOf(src.bytes, "endstream", value.start + value.length);
      end = indexOf(src.bytes, "endobj", es) + 6;
    }
    pdf.rawObject(num, src.bytes.subarray(e.a, end));
  }
  writePrivate(pdf, privNum, blocks, meta, { creatorVersion: c.privateInfo?.creatorVersion, roundtripVersion: c.privateInfo?.roundtripVersion }, options.compression ?? "zstd");
  const trailer: Record<string, PVal> = {};
  for (const k of ["Root", "Info", "ID"]) {
    const v = src.trailer.get(k);
    if (v === undefined) continue;
    if (isRef(v)) trailer[k] = ref(v.num);
    else if (Array.isArray(v)) trailer[k] = raw("[" + v.map((x) => (typeof x === "object" && x && "kind" in x && x.kind === "string" ? "<" + [...x.value].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, "0")).join("") + ">" : "")).join("") + "]");
  }
  return pdf.finish(trailer);
}

function generateRendition(doc: AiDocument, blocks: Uint8Array[], meta: Uint8Array, options: SaveOptions, c?: AiContainer): Uint8Array {
  const pdf = new PdfBuilder(1);
  const catalog = pdf.alloc();
  const pagesNum = pdf.alloc();
  const privNum = pdf.alloc();
  const pieceNum = pdf.alloc();
  const now = pdfDate();
  const rb = new RenditionBuilder(doc, pdf, options);
  const ocg = pdf.alloc();
  const pages = rb.pages(pagesNum, (i) => (i === 0 ? { PieceInfo: { Illustrator: ref(pieceNum) }, LastModified: now } : { LastModified: now }));
  pdf.object(ocg, { Type: name("OCG"), Name: doc.layers[0]?.layerName ?? "Layer 1" });
  pdf.object(pagesNum, { Type: name("Pages"), Kids: pages.map(ref), Count: pages.length });
  pdf.object(catalog, { Type: name("Catalog"), Pages: ref(pagesNum), OCProperties: { OCGs: [ref(ocg)], D: { ON: [ref(ocg)], Order: [ref(ocg)], RBGroups: [] } } });
  pdf.object(pieceNum, { LastModified: now, Private: ref(privNum) });
  writePrivate(pdf, privNum, blocks, meta, { creatorVersion: c?.privateInfo?.creatorVersion, roundtripVersion: c?.privateInfo?.roundtripVersion }, options.compression ?? "zstd");
  const info = pdf.alloc();
  pdf.object(info, { Creator: "ai-file", Producer: "ai-file", CreationDate: now, ModDate: now, Title: options.title ?? "Untitled" });
  return pdf.finish({ Root: ref(catalog), Info: ref(info) });
}

