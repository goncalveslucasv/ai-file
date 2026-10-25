// Serializes an AiDocument back into a native Illustrator stream.
//
// Untouched objects are copied byte-for-byte from the source stream; objects flagged `dirty`
// (and their ancestors) are regenerated from the model. Because the AI format relies on a
// sticky graphics state (an object may omit the fill color it shares with the previous one),
// the writer simulates that state and re-establishes, before every copied object, the exact
// state it was originally parsed with.

import { ByteWriter, fmt, fromLatin1, toUtf8ByteString } from "../bytes.ts";
import { BLEND_MODES, type AiDocument, type Art, type Color, type GradientPaint, type LayerArt, type Paint, type PathArt, type RasterArt } from "../model/types.ts";
import { applyStateOp, cloneGState, defaultGState, type GState, type ParseSideInfo } from "../parse/document.ts";
import { encodeAscii85, writeDict } from "../syntax/dict.ts";
import { escapeString, formatOperand, type Operand, type Statement } from "../syntax/lexer.ts";
import { writeTxt2, type TextDocument } from "../text/txt2.ts";

export interface SerializeOptions {
  /** Regenerate every object from the model instead of copying unchanged source bytes. */
  regenerate?: boolean;
  /** Line terminator for generated text (Illustrator uses "\r"). */
  eol?: string;
}

const n = (v: number): string => fmt(v);
const op = (o: Operand): string => formatOperand(o, n);
const str = (s: string): string => "(" + escapeString(toUtf8ByteString(s)) + ")";

/** True when the art or anything below it must be regenerated. */
export function hasDirty(a: Art, regenerate = false): boolean {
  if (regenerate || a.dirty || !a.span) return true;
  if ("children" in a) for (const c of a.children) if (hasDirty(c)) return true;
  if (a.source) for (const c of a.source) if (hasDirty(c)) return true;
  return false;
}

function colorOps(c: Color, stroke: boolean): string {
  const S = (lower: string): string => (stroke ? lower.toUpperCase() : lower);
  switch (c.kind) {
    case "gray":
      return `${n(c.gray)} ${S("g")}`;
    case "cmyk":
      return `${n(c.c)} ${n(c.m)} ${n(c.y)} ${n(c.k)} ${S("k")}`;
    case "rgb": {
      const k = c.cmyk ?? rgbToCmyk(c.r, c.g, c.b);
      return `${k.map(n).join(" ")} ${n(c.r)} ${n(c.g)} ${n(c.b)} ${stroke ? "XA" : "Xa"}`;
    }
    case "named": {
      const base = c.base;
      if (base.kind === "rgb") return `${n(base.r)} ${n(base.g)} ${n(base.b)} ${str(c.name)} ${n(c.tint)} 1 ${stroke ? "XX" : "Xx"}`;
      const k = base.kind === "cmyk" ? [base.c, base.m, base.y, base.k] : [0, 0, 0, 1];
      return `${k.map(n).join(" ")} ${str(c.name)} ${n(c.tint)} 0 ${stroke ? "XX" : "Xx"}`;
    }
    case "registration":
      return `1 1 1 1 ${str(c.name)} 0 ${stroke ? "X" : "x"}`;
  }
}

function rgbToCmyk(r: number, g: number, b: number): [number, number, number, number] {
  const k = 1 - Math.max(r, g, b);
  if (k >= 1) return [0, 0, 0, 1];
  return [(1 - r - k) / (1 - k), (1 - g - k) / (1 - k), (1 - b - k) / (1 - k), k];
}

function samePaint(a: Paint | null, b: Paint | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

class StreamWriter {
  readonly doc: AiDocument;
  readonly side?: ParseSideInfo;
  readonly st: Statement[];
  readonly src: Uint8Array;
  readonly out = new ByteWriter();
  readonly regenerate: boolean;
  readonly eol: string;
  /** Graphics state a consumer of the output would have at the current position. */
  g: GState = defaultGState();

  constructor(doc: AiDocument & { side?: ParseSideInfo }, opts: SerializeOptions) {
    this.doc = doc;
    this.side = doc.side;
    this.st = doc.statements;
    this.src = doc.source;
    this.regenerate = opts.regenerate ?? false;
    this.eol = opts.eol ?? "\r";
  }

  /** Copies statements [first, last] verbatim and replays their effect on the graphics state. */
  copyStatements(first: number, last: number): void {
    if (last < first) return;
    this.out.bytes(this.src.subarray(this.st[first].start, this.st[last].end));
    for (let i = first; i <= last; i++) applyStateOp(this.g, this.st[i]);
  }

  line(text: string, hidden = false): void {
    this.out.str(this.eol + (hidden ? "%_" : "") + text);
  }

  lines(texts: string[], hidden = false): void {
    for (const t of texts) this.line(t, hidden && !t.startsWith("%_") ? true : false);
  }

  // --------------------------------------------------------------------- graphics state

  /** Emits the operators needed to turn the current state into `want`. */
  syncState(want: GState, hidden: boolean, force = false): void {
    const g = this.g;
    const L = (t: string): void => this.line(t, hidden);
    // Illustrator writes the overprint flag right before the color it applies to.
    const fillChanged = want.fill !== null && want.fill.type !== "gradient" && (force || !samePaint(g.fill, want.fill));
    const strokeChanged = want.stroke !== null && want.stroke.type !== "gradient" && (force || !samePaint(g.stroke, want.stroke));
    if (fillChanged || force || g.fillOverprint !== want.fillOverprint) L(`${want.fillOverprint ? 1 : 0} O`);
    if (strokeChanged || g.strokeOverprint !== want.strokeOverprint) L(`${want.strokeOverprint ? 1 : 0} R`);
    if (fillChanged && want.fill?.type === "color") L(colorOps(want.fill.color, false));
    if (fillChanged && want.fill?.type === "pattern") L(`${want.fill.raw.map(op).join(" ")} p`);
    if (strokeChanged && want.stroke?.type === "color") L(colorOps(want.stroke.color, true));
    if (strokeChanged && want.stroke?.type === "pattern") L(`${want.stroke.raw.map(op).join(" ")} P`);
    const b = want.blend;
    if (force || JSON.stringify(g.blend) !== JSON.stringify(b)) {
      L(`${Math.max(0, BLEND_MODES.indexOf(b.mode))} ${n(b.opacity)} ${b.isolated ? 1 : 0} ${b.knockout} ${b.alphaIsShape ? 1 : 0} Xy`);
    }
    const s = want.strokeStyle, gs = g.strokeStyle;
    const strokeAttrsChanged = gs.cap !== s.cap || gs.join !== s.join || gs.width !== s.width || gs.miterLimit !== s.miterLimit || gs.dash.join() !== s.dash.join() || gs.dashOffset !== s.dashOffset;
    if (force || strokeAttrsChanged) {
      L(`${["butt", "round", "square"].indexOf(s.cap)} J ${["miter", "round", "bevel"].indexOf(s.join)} j ${n(s.width)} w ${n(s.miterLimit)} M [${s.dash.map(n).join(" ")}]${n(s.dashOffset)} d`);
    }
    if (force || g.fillRule !== want.fillRule) L(`${want.fillRule === "evenodd" ? 1 : 0} XR`);
    if (want.xd && (force || g.xd?.join() !== want.xd.join())) L(`${want.xd.map(n).join(" ")} Xd`);
    this.g = cloneGState({ ...want, fill: want.fill ?? g.fill, stroke: want.stroke ?? g.stroke });
  }

  // --------------------------------------------------------------------- art

  art(a: Art): void {
    if (!hasDirty(a, this.regenerate)) {
      const before = this.side?.stateBefore.get(a);
      if (before) this.syncState(before, a.illustratorOnly);
      this.copyStatements(a.span!.first, a.span!.last);
      return;
    }
    if ((a.type === "mesh" || a.type === "unknown") && a.span) {
      // Not modelled in enough detail to regenerate: always copied verbatim.
      const before = this.side?.stateBefore.get(a);
      if (before) this.syncState(before, a.illustratorOnly);
      this.copyStatements(a.span.first, a.span.last);
      return;
    }
    const h = a.illustratorOnly;
    this.prefix(a);
    switch (a.type) {
      case "layer":
        this.layer(a);
        break;
      case "group":
        this.line(a.clipGroup ? "q" : "u", h);
        for (const c of a.children) this.art(c);
        this.line(a.clipGroup ? "Q" : "U", h);
        break;
      case "compound":
        this.line("*u", h);
        for (const c of a.children) this.art(c);
        this.line("*U", h);
        break;
      case "path":
        this.path(a);
        break;
      case "raster":
        this.raster(a);
        break;
      case "text":
        this.lines(writeDict(a.textObject), h);
        break;
    }
    this.suffix(a);
  }

  prefix(a: Art): void {
    if (a.type === "layer") return;
    const h = a.illustratorOnly;
    if (a.locked) this.line("1 A", h);
    if (a.hidden) this.line("1 Xw", h);
    for (const s of a.extra) {
      if (s.op === "XW" || s.op === "%") continue;
      this.line([...s.args.map(op), s.op].join(" "), h);
    }
  }

  suffix(a: Art): void {
    const h = a.illustratorOnly;
    if (a.dictionary && a.type !== "layer") this.lines(writeDict(a.dictionary, { hidden: true }));
    let trailer = a.trailer;
    const blendLine = (b: NonNullable<Art["blend"]>): string =>
      `${Math.max(0, BLEND_MODES.indexOf(b.mode))} ${n(b.opacity)} ${b.isolated ? 1 : 0} ${b.knockout} ${b.alphaIsShape ? 1 : 0} Xy`;
    if (!trailer && a.blend && a.type !== "path" && a.type !== "layer" && (a.blend.opacity !== 1 || a.blend.mode !== "normal")) {
      trailer = { code: 6, styleName: "", attrs: [] };
    }
    if (trailer) {
      let wroteXy = false;
      for (const s of trailer.attrs) {
        if (s.op === "Xy" && a.blend && a.type !== "path") {
          this.line(blendLine(a.blend), h);
          this.g.blend = { ...a.blend };
          wroteXy = true;
          continue;
        }
        this.line([...s.args.map(op), s.op].join(" "), h);
        applyStateOp(this.g, s);
      }
      if (!wroteXy && a.blend && a.type !== "path" && !trailer.attrs.length) {
        this.line(blendLine(a.blend), h);
        this.g.blend = { ...a.blend };
        this.line("0 0 Xd", h);
      }
      this.line(`${trailer.code} ${str(trailer.styleName)} XW`, h);
    }
    if (a.source) {
      for (const s of a.source) this.art(s);
      this.line(`1 ${str(a.sourceStyle ?? "")} XW`);
    }
  }

  layer(a: LayerArt): void {
    this.line("%AI5_BeginLayer");
    const lb = [...a.lb];
    const nums = lb.filter((x): x is number => typeof x === "number");
    if (nums.length >= 5) {
      // visible preview enabled printing dimmed ...
      let k = 0;
      for (let i = 0; i < lb.length && k < 5; i++) {
        if (typeof lb[i] !== "number") continue;
        lb[i] = [a.visible, a.preview, !a.locked, a.printable, a.dimmed][k] ? 1 : 0;
        k++;
      }
    }
    this.line(`${lb.map(op).join(" ")} Lb`);
    this.line(`${str(a.layerName)} Ln`);
    for (const s of a.extra) this.line([...s.args.map(op), s.op].join(" "));
    if (a.dictionary) this.lines(writeDict(a.dictionary, { hidden: true }));
    for (const c of a.children) this.art(c);
    this.line("LB");
    this.line("%AI5_EndLayer--");
  }

  path(a: PathArt): void {
    const h = a.illustratorOnly;
    const want = cloneGState(this.g);
    const st = a.style;
    want.fill = st.fill && st.fill.type !== "gradient" ? st.fill : want.fill;
    want.stroke = st.stroke && st.stroke.type !== "gradient" ? st.stroke : want.stroke;
    want.strokeStyle = st.strokeStyle;
    want.fillRule = st.fillRule;
    want.fillOverprint = st.fillOverprint;
    want.strokeOverprint = st.strokeOverprint;
    want.blend = st.blend;
    if (st.xd) want.xd = st.xd;
    if (a.reversed !== undefined) this.line(`${a.reversed ? 1 : 0} D`, h);
    this.syncState(want, h);
    for (const s of a.segments) {
      const o = s.op && /^[mlLcCvVyY]$/.test(s.op) ? s.op : s.kind === "move" ? "m" : s.kind === "line" ? (s.smooth ? "l" : "L") : s.smooth ? "c" : "C";
      if (o === "m") this.line(`${n(s.x)} ${n(s.y)} m`, h);
      else if (o === "l" || o === "L") this.line(`${n(s.x)} ${n(s.y)} ${o}`, h);
      else if (o === "v" || o === "V") this.line(`${n(s.x2!)} ${n(s.y2!)} ${n(s.x)} ${n(s.y)} ${o}`, h);
      else if (o === "y" || o === "Y") this.line(`${n(s.x1!)} ${n(s.y1!)} ${n(s.x)} ${n(s.y)} ${o}`, h);
      else this.line(`${n(s.x1!)} ${n(s.y1!)} ${n(s.x2!)} ${n(s.y2!)} ${n(s.x)} ${n(s.y)} ${o}`, h);
    }
    const grad = st.fill?.type === "gradient" ? st.fill : st.stroke?.type === "gradient" ? st.stroke : null;
    if (grad) this.gradientStart(grad, h);
    if (a.clip) this.line("W", h);
    const fills = !!st.fill;
    const strokes = !!st.stroke;
    let p = fills && strokes ? "b" : fills ? "f" : strokes ? "s" : "n";
    if (!a.closed) p = p.toUpperCase();
    this.line(p, h);
    if (grad) this.line(`${grad.flag} BB`, h);
  }

  gradientStart(g: GradientPaint, h: boolean): void {
    this.line("Bb", h);
    this.line(`1 ${str(g.name)} ${n(g.origin[0])} ${n(g.origin[1])} ${n(g.angle)} ${n(g.length)} ${g.bgMatrix.map(n).join(" ")} 1 Bg`, h);
    if (g.unitVector) this.line(`${g.matrix.map(n).join(" ")} Xm`, h);
    else this.line(`${g.matrix.map(n).join(" ")} Bm`, h);
  }

  raster(a: RasterArt): void {
    const h = a.illustratorOnly;
    const m = `[ ${a.matrix.map(n).join(" ")} ]`;
    this.line("%AI5_File:", h);
    this.line("%AI5_BeginRaster", h);
    this.line(`${str(a.file)} ${a.linked ? 1 : 0} XG`, h);
    this.line(`/${a.colorSpace} XN`, h);
    this.line(`${m} ${a.width} ${a.height} 0 Xh`, h);
    // XI: [m] llx lly urx ury w h bits channels alpha reserved binary mask ... (extra operands kept)
    const tail = a.xi.slice(a.xi.findIndex((x) => typeof x === "object" && x !== null && x.t === "a") + 1);
    const nums = tail.filter((x): x is number => typeof x === "number");
    const rest = nums.length > 9 ? nums.slice(9) : [17, 1, 0, 4, 4, 0, 0];
    this.line(`${m} 0 0 ${a.width} ${a.height} ${a.width} ${a.height} ${a.bitsPerComponent} ${a.channels} ${a.alphaChannels} ${rest.map(n).join(" ")}`, h);
    const color = Math.ceil((a.width * a.bitsPerComponent * a.channels) / 8) * a.height;
    this.line(`%%BeginData: ${color + 3}`, h);
    this.out.str(this.eol + "XI\n");
    if (a.dataRange) this.out.bytes(this.src.subarray(a.dataRange[0], a.dataRange[1]));
    this.out.str(h ? "%_%%EndData" : "%%EndData");
    this.line("XH", h);
    this.line("%AI17_Begin_Content_if_version_gt:24 17");
    this.line("72 72 Xr", h);
    this.line("%AI17_End_Versioned_Content");
    this.line("%AI5_EndRaster", h);
    this.line("N", h);
  }

  // --------------------------------------------------------------------- document

  run(): Uint8Array {
    const doc = this.doc;
    const [bodyFirst, bodyEnd] = doc.bodyRange;
    const text = doc.textDirty ? doc.sections.textDocument : undefined;
    const numLayers = doc.sections.numLayersComment;
    const special = new Set<number>();
    if (numLayers !== undefined) special.add(numLayers);
    if (text) special.add(text[0]);
    const copyRange = (from: number, to: number): void => {
      let i = from;
      while (i < to) {
        if (i === numLayers) {
          const raw = this.src.subarray(this.st[i].start, this.st[i].end);
          const pct = raw.indexOf(0x25);
          this.out.bytes(raw.subarray(0, Math.max(0, pct)));
          this.out.str(`%AI5_NumLayers: ${doc.layers.length}`);
          i++;
          continue;
        }
        if (text && i === text[0]) {
          this.textSection();
          i = text[1] + 1;
          continue;
        }
        let next = i;
        while (next < to && !special.has(next)) next++;
        this.copyStatements(i, next - 1);
        i = next;
      }
    };
    copyRange(0, bodyFirst);
    this.g = defaultGState();
    for (const layer of doc.layers) this.art(layer);
    const tail = doc.sections.bodyTail ?? bodyEnd;
    copyRange(tail, this.st.length);
    return this.out.toBytes();
  }

  textSection(): void {
    const doc = this.doc;
    const enc = (td: TextDocument | undefined): string[] => {
      if (!td) return [];
      const a85 = encodeAscii85(fromLatin1(writeTxt2(td.root)));
      const out: string[] = [];
      for (let k = 0; k < a85.length; k += 100) out.push("%" + a85.slice(k, k + 100));
      return out;
    };
    this.line("%AI11_BeginTextDocument");
    if (doc.text) {
      this.line("/AI11TextDocument : /ASCII85Decode ,");
      this.lines(enc(doc.text));
      this.line(`${n(doc.text.rulerOrigin[0])} ${n(doc.text.rulerOrigin[1])} /RulerOrigin ,`);
      this.line(";");
    }
    if (doc.undoFreeText) {
      this.line("/AI11UndoFreeTextDocument : /ASCII85Decode ,");
      this.lines(enc(doc.undoFreeText));
      this.line(";");
    }
    this.line("%AI11_EndTextDocument");
  }
}

/** Produces the native stream for `doc`. Unmodified documents are returned byte-identical. */
export function serializeAiStream(doc: AiDocument, options: SerializeOptions = {}): Uint8Array {
  const dirty = options.regenerate || doc.textDirty || doc.layers.some((l) => hasDirty(l));
  if (!dirty && doc.layers.length > 0) return doc.source;
  return new StreamWriter(doc, options).run();
}

export function markDirty(a: Art): void {
  a.dirty = true;
}
