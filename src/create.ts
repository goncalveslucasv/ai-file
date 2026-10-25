// Creates new, empty documents by parsing a minimal native stream template.

import { fmt, fromLatin1, toUtf8ByteString } from "./bytes.ts";
import type { AiDocument } from "./model/types.ts";
import { parseAiStream } from "./parse/document.ts";
import { escapeString } from "./syntax/lexer.ts";

export interface NewDocumentOptions {
  /** Artboards in points; laid out left to right with `gap` between them. */
  artboards?: { name?: string; width: number; height: number }[];
  gap?: number;
  layerName?: string;
  title?: string;
}

const s = (v: string): string => "(" + escapeString(toUtf8ByteString(v)) + ")";

/** Builds the native stream text for an empty document. */
export function emptyStreamText(options: NewDocumentOptions = {}): string {
  const boards = options.artboards?.length ? options.artboards : [{ name: "Artboard 1", width: 612, height: 792 }];
  const gap = options.gap ?? 20;
  let x = 0;
  const rects = boards.map((b, i) => {
    const r = { name: b.name ?? `Artboard ${i + 1}`, left: x, top: 0, right: x + b.width, bottom: -b.height };
    x += b.width + gap;
    return r;
  });
  const minX = Math.min(...rects.map((r) => r.left)), maxX = Math.max(...rects.map((r) => r.right));
  const minY = Math.min(...rects.map((r) => r.bottom)), maxY = Math.max(...rects.map((r) => r.top));
  const n = (v: number): string => fmt(v);
  const L: string[] = [
    "%!PS-Adobe-3.0 ",
    "%%Creator: Adobe Illustrator(R) 24.0",
    "%%AI8_CreatorVersion: 30.0.0",
    `%%Title: ${s(options.title ?? "Untitled")}`,
    `%%BoundingBox: ${Math.floor(minX)} ${Math.floor(minY)} ${Math.ceil(maxX)} ${Math.ceil(maxY)}`,
    `%%HiResBoundingBox: ${n(minX)} ${n(minY)} ${n(maxX)} ${n(maxY)}`,
    "%%DocumentProcessColors: Cyan Magenta Yellow Black",
    "%AI5_FileFormat 14.0",
    "%AI12_BuildNumber: 1",
    "%AI3_ColorUsage: Color",
    "%AI7_ImageSettings: 0",
    "%%RGBProcessColor: 0 0 0 ([Registration])",
    `%AI3_Cropmarks: ${n(rects[0].left)} ${n(rects[0].bottom)} ${n(rects[0].right)} ${n(rects[0].top)}`,
    "%AI3_DocumentPreview: None",
    "%AI5_ArtSize: 14400 14400",
    "%AI5_RulerUnits: 2",
    "%AI24_LargeCanvasScale: 1",
    "%AI9_ColorModel: 1",
    "%AI5_ArtFlags: 0 0 0 1 0 0 1 0 0",
    "%AI5_TargetResolution: 800",
    "%AI5_NumLayers: 1",
    "%AI9_OpenToView: -100 100 1 1500 833 18 1 0 6 58 0 0 0 1 1 0 1 1 0 0",
    "%AI5_OpenViewLayers: 7",
    "%AI7_GridSettings: 72 8 72 8 1 0 0.8 0.8 0.8 0.9 0.9 0.9",
    "%AI9_Flatten: 1",
    "%AI12_CMSettings: 00.MO",
    "%%EndComments",
    "%%BeginProlog",
    "%%EndProlog",
    "%%BeginSetup",
    "%AI9_BeginDocumentData",
    "%_/Document :",
    "%_/Dictionary :",
    "%_/Array :",
    ...rects.flatMap((r) => [
      "%_/Dictionary :",
      "%_0 /Int (DisplayMark) ,",
      `%_${n(r.left)} ${n(r.top)} /RealPointRelToROrigin`,
      "%_ (PositionPoint1) ,",
      `%_${s(r.name)} /UnicodeString (Name) ,`,
      `%_${n(r.right)} ${n(r.bottom)} /RealPointRelToROrigin`,
      "%_ (PositionPoint2) ,",
      "%_1 /Real (PAR) ,",
      "%_0 /Bool (IsArtboardLocked) ,",
      "%_0 /Bool (IsArtboardDefaultName) ,",
      "%_0 /Bool (IsArtboardSelected) ,",
      "%_; ,",
    ]),
    "%_; (ArtboardArray) ,",
    "%_0 /Int (CropAreaActive) ,",
    "%_; /Recorded ,",
    "%_;",
    "%AI9_EndDocumentData",
    "%%EndSetup",
    "%AI5_BeginLayer",
    "1 1 1 1 0 0 1 0 79 128 255 0 50 0 Lb",
    `${s(options.layerName ?? "Layer 1")} Ln`,
    "0 A",
    "LB",
    "%AI5_EndLayer--",
    "%%PageTrailer",
    "gsave annotatepage grestore showpage",
    "%%Trailer",
    "%%EOF",
  ];
  return L.join("\r") + "\r";
}

/** Creates a new, empty document ready to be edited and saved with saveAiFile(). */
export function createDocument(options: NewDocumentOptions = {}): AiDocument {
  return parseAiStream(fromLatin1(emptyStreamText(options)));
}
