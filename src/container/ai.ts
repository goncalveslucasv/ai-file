// Locates and decompresses the native Illustrator stream inside an .ai file.
//
// Layouts handled:
//  - PDF-compatible .ai (Illustrator 9+): a regular PDF whose first page carries
//    /PieceInfo /Illustrator /Private, a dictionary with /AIMetaData (the plain
//    %!PS header) and /AIPrivateData1..N. The private data blocks are concatenated
//    and hold the native stream, optionally compressed:
//      "%AI24_ZStandard_Data" + zstd frame(s)   (Illustrator 2020+)
//      "%AI12_CompressedData" + zlib stream      (Illustrator CS2..2019)
//      plain text                                 (Illustrator 9..CS)
//  - Legacy PostScript .ai (Illustrator <= 8, or "PDF compatible" off): the file *is* the stream.
//  - DOS EPS binary header (C5 D0 D3 C6): the PostScript section is the stream.

import { Decompress as ZstdDecompress } from "fzstd";
import { Unzlib, Inflate } from "fflate";
import { concatBytes, indexOf, latin1, startsWith } from "../bytes.ts";
import { PdfReader, isRef, isStream, type PdfDict, type PdfStream, type PdfValue } from "./pdf.ts";

export type AiCompression = "zstd" | "deflate" | "none";

export interface AiPrivateInfo {
  containerVersion?: number;
  creatorVersion?: number;
  roundtripVersion?: number;
  roundtripStreamType?: number;
  numBlocks: number;
  /** Object number of the /Private dictionary. */
  privateObject?: number;
}

export interface AiContainer {
  format: "pdf" | "postscript" | "eps";
  pdf?: PdfReader;
  /** The decompressed native Illustrator stream. */
  stream: Uint8Array;
  /** Plain %!PS header stored next to the private data (PDF layout only). */
  metadata?: Uint8Array;
  compression: AiCompression;
  privateInfo?: AiPrivateInfo;
  /** Number of PDF pages (one per artboard) when the PDF rendition exists. */
  pageCount?: number;
}

export interface OpenOptions {
  /** Called while decompressing; `done` and `total` are compressed byte counts. */
  onProgress?: (done: number, total: number) => void;
}

const ZSTD_TAG = "%AI24_ZStandard_Data";
const ZLIB_TAG = "%AI12_CompressedData";

export function openAiContainer(bytes: Uint8Array, options: OpenOptions = {}): AiContainer {
  if (bytes[0] === 0xc5 && bytes[1] === 0xd0 && bytes[2] === 0xd3 && bytes[3] === 0xc6) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const off = dv.getUint32(4, true);
    const len = dv.getUint32(8, true);
    return { format: "eps", stream: bytes.subarray(off, off + len), compression: "none" };
  }
  const head = latin1(bytes, 0, Math.min(bytes.length, 1024));
  if (head.includes("%PDF-")) return openPdfContainer(bytes, options);
  if (head.startsWith("%!PS-Adobe")) return { format: "postscript", stream: bytes, compression: "none" };
  throw new Error("Not an Adobe Illustrator file (neither PDF nor PostScript header found)");
}

function openPdfContainer(bytes: Uint8Array, options: OpenOptions): AiContainer {
  const pdf = new PdfReader(bytes);
  const found = findPrivateDict(pdf);
  if (!found) {
    throw new Error(
      "This PDF has no Illustrator private data (it was saved without \"Preserve Illustrator Editing Capabilities\"); only the PDF rendition is available.",
    );
  }
  const { dict, objectNumber } = found;
  const blocks: Uint8Array[] = [];
  const keys = [...dict.keys()]
    .map((k) => /^AIPrivateData(\d+)$/.exec(k))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  for (const m of keys) {
    const s = pdf.resolve(dict.get(m[0]));
    if (!isStream(s)) throw new Error(`Broken ${m[0]}`);
    blocks.push(readStreamBytes(pdf, s));
  }
  let metadata: Uint8Array | undefined;
  const meta = pdf.resolve(dict.get("AIMetaData"));
  if (isStream(meta)) metadata = readStreamBytes(pdf, meta);

  const num = (k: string): number | undefined => {
    const v = pdf.resolve(dict.get(k));
    return typeof v === "number" ? v : undefined;
  };
  const privateInfo: AiPrivateInfo = {
    containerVersion: num("ContainerVersion"),
    creatorVersion: num("CreatorVersion"),
    roundtripVersion: num("RoundtripVersion"),
    roundtripStreamType: num("RoundtripStreamType"),
    numBlocks: blocks.length,
    privateObject: objectNumber,
  };
  const { stream, compression } = decodePrivateBlocks(blocks, options);
  return { format: "pdf", pdf, stream, metadata, compression, privateInfo, pageCount: countPages(pdf) };
}

function readStreamBytes(pdf: PdfReader, s: PdfStream): Uint8Array {
  return s.dict.has("Filter") ? pdf.decodeStream(s) : pdf.rawStream(s);
}

function countPages(pdf: PdfReader): number | undefined {
  const root = pdf.resolve(pdf.trailer.get("Root"));
  if (!(root instanceof Map)) return undefined;
  const pages = pdf.resolve(root.get("Pages"));
  if (!(pages instanceof Map)) return undefined;
  const count = pdf.resolve(pages.get("Count"));
  return typeof count === "number" ? count : undefined;
}

function findPrivateDict(pdf: PdfReader): { dict: PdfDict; objectNumber?: number } | null {
  const root = pdf.resolve(pdf.trailer.get("Root"));
  if (!(root instanceof Map)) return null;
  // Walk the page tree; Illustrator attaches the private data to the first page.
  const stack: PdfValue[] = [root.get("Pages") ?? null];
  while (stack.length) {
    const nodeRef = stack.shift();
    const node = pdf.resolve(nodeRef);
    if (!(node instanceof Map)) continue;
    const kids = pdf.resolve(node.get("Kids"));
    if (Array.isArray(kids)) {
      stack.unshift(...kids);
      continue;
    }
    const piece = pdf.resolve(node.get("PieceInfo"));
    if (!(piece instanceof Map)) continue;
    const ill = pdf.resolve(piece.get("Illustrator"));
    if (!(ill instanceof Map)) continue;
    const privRef = ill.get("Private");
    const priv = pdf.resolve(privRef);
    if (priv instanceof Map) return { dict: priv, objectNumber: isRef(privRef) ? privRef.num : undefined };
  }
  // Fallback: scan every object for an AIPrivateData1 key.
  for (const num of pdf.xref.keys()) {
    const v = pdf.get(num);
    if (v instanceof Map && v.has("AIPrivateData1")) return { dict: v, objectNumber: num };
  }
  return null;
}

/** Concatenates and decompresses the AIPrivateData blocks. */
export function decodePrivateBlocks(blocks: Uint8Array[], options: OpenOptions = {}): { stream: Uint8Array; compression: AiCompression } {
  if (blocks.length === 0) throw new Error("No AIPrivateData blocks");
  const first = blocks[0];
  const total = blocks.reduce((n, b) => n + b.length, 0);
  let compression: AiCompression = "none";
  let skip = 0;
  if (startsWith(first, ZSTD_TAG)) {
    compression = "zstd";
    skip = ZSTD_TAG.length;
  } else if (startsWith(first, ZLIB_TAG)) {
    compression = "deflate";
    skip = ZLIB_TAG.length;
  }
  if (compression === "none") return { stream: blocks.length === 1 ? first : concatBytes(blocks), compression };

  const out: Uint8Array[] = [];
  let done = 0;
  const feed = (push: (chunk: Uint8Array, final: boolean) => void): void => {
    blocks.forEach((b, i) => {
      const chunk = i === 0 ? b.subarray(skip) : b;
      push(chunk, i === blocks.length - 1);
      done += b.length;
      options.onProgress?.(done, total);
    });
  };
  if (compression === "zstd") {
    const d = new ZstdDecompress((data) => {
      out.push(data);
    });
    feed((c, final) => d.push(c, final));
  } else {
    // zlib header (78 xx) is the norm; fall back to raw deflate otherwise.
    const firstByte = first[skip];
    const z = (firstByte & 0x0f) === 8 ? new Unzlib((data) => out.push(data)) : new Inflate((data) => out.push(data));
    feed((c, final) => z.push(c, final));
  }
  return { stream: out.length === 1 ? out[0] : concatBytes(out), compression };
}

/** Quick check usable on a file header (first ~1 KB). */
export function looksLikeAi(head: Uint8Array): boolean {
  if (head[0] === 0xc5 && head[1] === 0xd0 && head[2] === 0xd3 && head[3] === 0xc6) return true;
  return indexOf(head, "%PDF-") >= 0 || (startsWith(head, "%!PS-Adobe") && indexOf(head, "Illustrator") >= 0);
}

