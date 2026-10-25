// Document model for a native Illustrator stream.
//
// Coordinates are Illustrator "art space": points, y axis pointing UP (PostScript convention),
// exactly as stored in the file. Artboard rectangles are in the same space.

import type { DictNode } from "../syntax/dict.ts";
import type { Operand, Statement } from "../syntax/lexer.ts";
import type { TextDocument } from "../text/txt2.ts";

/** [a b c d tx ty] — maps (x, y) to (a*x + c*y + tx, b*x + d*y + ty). */
export type Matrix = [number, number, number, number, number, number];

// ----------------------------------------------------------------------------- colors & paint

export type Color =
  | { kind: "gray"; gray: number }
  | { kind: "cmyk"; c: number; m: number; y: number; k: number }
  /** Xa/XA colors carry a CMYK fallback alongside the RGB value. */
  | { kind: "rgb"; r: number; g: number; b: number; cmyk?: [number, number, number, number] }
  /** Named (spot / global process) color with a tint. `base` is the color the name refers to. */
  | { kind: "named"; name: string; tint: number; base: Color; spot: boolean }
  | { kind: "registration"; name: string };

export interface GradientStop {
  /** 0..1 along the ramp. */
  offset: number;
  /** Midpoint to the next stop, 0..1 (Illustrator default 0.5). */
  midpoint: number;
  color: Color;
  opacity: number;
  /** Raw operands of the Bs statement. */
  raw: Operand[];
}

export interface GradientDef {
  name: string;
  type: "linear" | "radial";
  stops: GradientStop[];
}

export interface GradientPaint {
  type: "gradient";
  name: string;
  /** Gradient-space origin / angle (degrees) / length, as written by Bg. */
  origin: [number, number];
  angle: number;
  length: number;
  /** Matrix written by Bg (usually identity). */
  bgMatrix: Matrix;
  /**
   * Gradient-to-art matrix. With Xm (Illustrator 9+) the gradient vector is unit: it runs from
   * matrix·(0,0) to matrix·(1,0) (radial: center matrix·(0,0), radius vector matrix·(1,0)).
   * Without Xm (legacy files) the vector is origin -> origin + length·(cos angle, sin angle),
   * transformed by `matrix` (= Bg matrix).
   */
  matrix: Matrix;
  /** True when `matrix` comes from Xm. */
  unitVector: boolean;
  /** Radial highlight (Bh): [x, y, angle, length]. */
  highlight?: [number, number, number, number];
  /** 0 = fill (Bb ... 0 BB), other values as found. */
  flag: number;
}

export interface PatternPaint {
  type: "pattern";
  name: string;
  /** Raw operands of the p / P statement. */
  raw: Operand[];
}

export type Paint = { type: "color"; color: Color } | GradientPaint | PatternPaint;

export type BlendMode =
  | "normal" | "multiply" | "screen" | "overlay" | "soft-light" | "hard-light" | "color-dodge" | "color-burn"
  | "darken" | "lighten" | "difference" | "exclusion" | "hue" | "saturation" | "color" | "luminosity";

/** Order matches Illustrator's AIBlendingMode enum (first operand of Xy). */
export const BLEND_MODES: BlendMode[] = [
  "normal", "multiply", "screen", "overlay", "soft-light", "hard-light", "color-dodge", "color-burn",
  "darken", "lighten", "difference", "exclusion", "hue", "saturation", "color", "luminosity",
];

/** Xy: mode opacity isolated knockout alphaIsShape. */
export interface BlendStyle {
  mode: BlendMode;
  opacity: number;
  isolated: boolean;
  /** 0 off, 1 on, 2 inherited. */
  knockout: number;
  alphaIsShape: boolean;
}

export interface StrokeStyle {
  width: number;
  cap: "butt" | "round" | "square";
  join: "miter" | "round" | "bevel";
  miterLimit: number;
  dash: number[];
  dashOffset: number;
}

/** Paint attributes of a path, resolved from the running graphics state. */
export interface PathStyle {
  fill: Paint | null;
  stroke: Paint | null;
  strokeStyle: StrokeStyle;
  fillRule: "nonzero" | "evenodd";
  fillOverprint: boolean;
  strokeOverprint: boolean;
  blend: BlendStyle;
  /** Xd operands: [strokeAlignment?, paintOrder?] — semantics only partially known, kept verbatim. */
  xd?: [number, number];
}

// ----------------------------------------------------------------------------- geometry

export type SegmentKind = "move" | "line" | "curve";
export interface PathSegment {
  kind: SegmentKind;
  /** End point. */
  x: number;
  y: number;
  /** Bezier control points for curves. */
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  /** Lowercase operators (l, c, v, y) mark smooth anchor points; uppercase are corners. */
  smooth: boolean;
  /** Original operator (m l L c C v V y Y) for faithful re-emission. */
  op: string;
}

// ----------------------------------------------------------------------------- art tree

export interface SourceSpan {
  /** Statement index range [first, last] (inclusive) covering the art object. */
  first: number;
  last: number;
}

export interface ArtBase {
  /** Stable id within the parsed document (not stored in the file). */
  id: number;
  /** Object name / UID (AI10_ArtUID in the art dictionary) when present. */
  name?: string;
  locked: boolean;
  hidden: boolean;
  /** Statements only Illustrator reads (inside %_ regions). */
  illustratorOnly: boolean;
  /** Parsed art dictionary (%_/ArtDictionary). */
  dictionary?: DictNode;
  /** XW trailer: `code (styleName) XW`. */
  trailer?: {
    code: number;
    styleName: string;
    /** Attribute statements written between the object and XW (Xy, Xd, stroke attributes...). */
    attrs: Statement[];
  };
  /**
   * When this art is the expanded/rendered result of an appearance (effects, multiple fills...),
   * `source` is the editable original Illustrator keeps hidden, and `styleName` its art style.
   */
  source?: Art[];
  sourceStyle?: string;
  /** Blend attributes that apply to the object (from the trailer or object attributes). */
  blend?: BlendStyle;
  /** Unknown attribute statements attached to this object, kept for round-trips. */
  extra: Statement[];
  span?: SourceSpan;
  /** Set by editing helpers; dirty objects are regenerated by the writer. */
  dirty?: boolean;
}

export interface PathArt extends ArtBase {
  type: "path";
  segments: PathSegment[];
  closed: boolean;
  /** Paint operator used (f F s S b B n N). */
  paintOp: string;
  /** The path is (also) a clipping path (W). */
  clip: boolean;
  style: PathStyle;
  /** Compound path sub-path direction flag (D). */
  reversed?: boolean;
}

export interface CompoundPathArt extends ArtBase {
  type: "compound";
  children: PathArt[];
}

export interface GroupArt extends ArtBase {
  type: "group";
  /** q/Q clip group: clipping paths (path.clip) mask the other children. */
  clipGroup: boolean;
  children: Art[];
}

export interface RasterArt extends ArtBase {
  type: "raster";
  /** Image matrix as written (Xh). Pixel (u, v) maps to art space through matrix with v pointing down. */
  matrix: Matrix;
  width: number;
  height: number;
  bitsPerComponent: number;
  /** Number of color channels (1 gray, 3 RGB, 4 CMYK). */
  channels: number;
  alphaChannels: number;
  colorSpace: string;
  /** Link path (XG) and whether it is linked (1) or embedded (0). */
  file: string;
  linked: boolean;
  /** Offsets of the interleaved color samples followed by the alpha plane inside the stream. */
  dataRange?: [number, number];
  /** XI operands verbatim. */
  xi: Operand[];
}

export interface TextArt extends ArtBase {
  type: "text";
  storyIndex: number;
  /** /FreeUndo 1: story and frame indices refer to `AiDocument.undoFreeText`. */
  undoFree: boolean;
  frameIndex: number;
  /** /AI11Text container (FreeUndo, FrameIndex, StoryIndex, TextAntialiasing...). */
  textObject: DictNode;
  style: PathStyle;
}

export interface MeshPatchNode {
  color: number[];
  x: number;
  y: number;
  /** Handle towards the next corner of the patch. */
  hNext: [number, number];
  /** Handle towards the previous corner. */
  hPrev: [number, number];
}

export interface MeshArt extends ArtBase {
  type: "mesh";
  rows: number;
  cols: number;
  colorSpace: string;
  patches: { row: number; col: number; nodes: MeshPatchNode[] }[];
}

/** Anything not modelled: plugin art, placed files, legacy text... kept verbatim. */
export interface UnknownArt extends ArtBase {
  type: "unknown";
  kind: string;
}

export interface LayerArt extends ArtBase {
  type: "layer";
  layerName: string;
  visible: boolean;
  preview: boolean;
  printable: boolean;
  dimmed: boolean;
  /** Highlight color (0..255). */
  color: [number, number, number];
  /** Lb operands verbatim. */
  lb: Operand[];
  children: Art[];
}

export type Art = PathArt | CompoundPathArt | GroupArt | RasterArt | TextArt | MeshArt | UnknownArt | LayerArt;

// ----------------------------------------------------------------------------- document

export interface Artboard {
  name: string;
  /** Art-space rectangle (y up): left, top, right, bottom. */
  left: number;
  top: number;
  right: number;
  bottom: number;
  uuid?: string;
  rulerOrigin?: [number, number];
}

export interface Swatch {
  name: string;
  color: Color;
}

export interface SymbolDef {
  name: string;
  art: Art[];
}

export interface PatternDef {
  name: string;
  art: Art[];
  /** Raw statements of the definition. */
  span: SourceSpan;
}

export interface ArtStyle {
  name: string;
  /** "/KnownStyle" container (filters, fill/stroke styles...). */
  node: DictNode;
  /** Simple fill/stroke style when the style is a /SimpleStyle. */
  simple?: PathStyle;
}

export interface AiHeader {
  /** "%%Key: value" and "%AIx_Key: value" comment lines from the header, in order. */
  comments: { key: string; value: string }[];
  creator?: string;
  creatorVersion?: string;
  fileFormat?: string;
  boundingBox?: [number, number, number, number];
  rulerUnits?: number;
  documentFonts: string[];
}

export interface AiDocument {
  header: AiHeader;
  artboards: Artboard[];
  layers: LayerArt[];
  swatches: Swatch[];
  gradients: Map<string, GradientDef>;
  patterns: Map<string, PatternDef>;
  symbols: Map<string, SymbolDef>;
  artStyles: Map<string, ArtStyle>;
  /** %AI9_BeginDocumentData container. */
  documentData?: DictNode;
  /** Parsed %AI11_BeginTextDocument. */
  text?: TextDocument;
  /**
   * %AI11_BeginTextDocument also carries /AI11UndoFreeTextDocument: the stories referenced by text
   * objects flagged /FreeUndo 1 (the copies inside expanded appearance results).
   */
  undoFreeText?: TextDocument;
  /** Source stream and its statements (needed for raster data and lossless saving). */
  source: Uint8Array;
  statements: Statement[];
  /** Statement index where the art section (first layer) begins / ends (after last layer). */
  bodyRange: [number, number];
  /** Statement ranges [first, last] of setup sections the writer may regenerate. */
  sections: { textDocument?: [number, number]; numLayersComment?: number; bodyTail?: number };
  /** Set when a text document was edited; the writer then re-encodes the text section. */
  textDirty?: boolean;
  /** Warnings produced while parsing (unknown operators, recoveries...). */
  warnings: string[];
}
