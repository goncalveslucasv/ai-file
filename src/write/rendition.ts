// Generates the PDF rendition of a document (one page per artboard) from the native model.
// Illustrator itself ignores this rendition when the private data is present; it is what
// other PDF readers, Finder previews, browsers... display.

import { ByteWriter, fmt } from "../bytes.ts";
import { toRgb } from "../model/color.ts";
import type { AiDocument, Art, Artboard, GradientDef, GradientPaint, MeshArt, Paint, PathArt, PathSegment, RasterArt, TextArt } from "../model/types.ts";
import { tessellateMesh } from "../render/mesh.ts";
import { rasterToPlanes } from "../render/png.ts";
import { deflate } from "../wasm/codec.ts";
import { textToArt, type TextDocument, type TextPaint } from "../text/txt2.ts";
import { name, ref, type PdfBuilder, type PVal } from "./pdfobj.ts";

export interface RenditionOptions {
  /** Longest side of embedded images (default 4096). */
  maxImageSize?: number;
  /** zlib level for image data (default 6). */
  level?: number;
}

const f = (n: number): string => fmt(n, 4);

interface PageRes {
  ext: Map<string, string>;
  shadings: Map<string, number>;
  xobjects: Map<string, number>;
  font: boolean;
}

export class RenditionBuilder {
  readonly doc: AiDocument;
  readonly pdf: PdfBuilder;
  readonly opts: Required<RenditionOptions>;
  private images = new Map<string, number>();
  private extObjs = new Map<string, number>();
  private fontRef = 0;

  constructor(doc: AiDocument, pdf: PdfBuilder, opts: RenditionOptions = {}) {
    this.doc = doc;
    this.pdf = pdf;
    this.opts = { maxImageSize: 4096, level: 6, ...opts };
  }

  /** Writes one page object per artboard and returns their object numbers. */
  pages(parent: number, extra: (i: number) => Record<string, PVal | undefined> = () => ({})): number[] {
    return this.doc.artboards.map((ab, i) => {
      const res: PageRes = { ext: new Map(), shadings: new Map(), xobjects: new Map(), font: false };
      const body = new ByteWriter();
      body.str(`1 0 0 1 ${f(-ab.left)} ${f(-ab.bottom)} cm\n`);
      for (const layer of this.doc.layers) this.art(layer, body, res, 1, ab);
      const content = this.pdf.alloc();
      const data = body.toBytes();
      this.pdf.stream(content, { Filter: name("FlateDecode") }, deflate(data, 6));
      const page = this.pdf.alloc();
      const w = ab.right - ab.left, h = ab.top - ab.bottom;
      const box = [0, 0, w, h];
      const resources: Record<string, PVal> = {};
      if (res.ext.size) resources.ExtGState = Object.fromEntries([...res.ext].map(([k, v]) => [v, ref(this.extObjs.get(k)!)]));
      if (res.shadings.size) resources.Shading = Object.fromEntries([...res.shadings].map(([k, v]) => [k, ref(v)]));
      if (res.xobjects.size) resources.XObject = Object.fromEntries([...res.xobjects].map(([k, v]) => [k, ref(v)]));
      if (res.font) resources.Font = { F1: ref(this.font()) };
      this.pdf.object(page, { Type: name("Page"), Parent: ref(parent), MediaBox: box, CropBox: box, ArtBox: box, TrimBox: box, Contents: ref(content), Resources: resources, ...extra(i) });
      return page;
    });
  }

  private font(): number {
    if (!this.fontRef) {
      this.fontRef = this.pdf.alloc();
      this.pdf.object(this.fontRef, { Type: name("Font"), Subtype: name("Type1"), BaseFont: name("Helvetica"), Encoding: name("WinAnsiEncoding") });
    }
    return this.fontRef;
  }

  private gs(res: PageRes, fillAlpha: number, strokeAlpha: number, blend: string, smask?: number): string {
    const key = `${fmt(fillAlpha, 3)}/${fmt(strokeAlpha, 3)}/${blend}/${smask ?? ""}`;
    if (!this.extObjs.has(key)) {
      const num = this.pdf.alloc();
      const BM: Record<string, string> = { normal: "Normal", multiply: "Multiply", screen: "Screen", overlay: "Overlay", "soft-light": "SoftLight", "hard-light": "HardLight", "color-dodge": "ColorDodge", "color-burn": "ColorBurn", darken: "Darken", lighten: "Lighten", difference: "Difference", exclusion: "Exclusion", hue: "Hue", saturation: "Saturation", color: "Color", luminosity: "Luminosity" };
      this.pdf.object(num, { Type: name("ExtGState"), ca: fillAlpha, CA: strokeAlpha, BM: name(BM[blend] ?? "Normal"), SMask: smask ? ref(smask) : name("None") });
      this.extObjs.set(key, num);
    }
    if (!res.ext.has(key)) res.ext.set(key, `GS${res.ext.size}`);
    return res.ext.get(key)!;
  }

  private art(a: Art, out: ByteWriter, res: PageRes, alpha: number, ab: Artboard): void {
    if (a.hidden) return;
    switch (a.type) {
      case "layer":
        if (!a.visible) return;
        for (const c of a.children) this.art(c, out, res, alpha, ab);
        return;
      case "group": {
        const op = alpha * (a.blend?.opacity ?? 1);
        out.str("q\n");
        if (a.blend && a.blend.mode !== "normal") out.str(`/${this.gs(res, 1, 1, a.blend.mode)} gs\n`);
        let children = a.children;
        if (a.clipGroup) {
          const clips = children.filter((c) => c.type === "path" && c.clip) as PathArt[];
          if (clips.length) {
            for (const c of clips) out.str(segments(c.segments, c.closed) + (c.style.fillRule === "evenodd" ? "W* n\n" : "W n\n"));
            children = children.filter((c) => !clips.includes(c as PathArt));
          }
        }
        for (const c of children) this.art(c, out, res, op, ab);
        out.str("Q\n");
        return;
      }
      case "compound": {
        const first = a.children[0];
        if (!first) return;
        const d = a.children.map((p) => segments(p.segments, p.closed)).join("");
        this.paintPath(d, { ...first, closed: true }, out, res, alpha * (a.blend?.opacity ?? 1));
        return;
      }
      case "path":
        if (a.clip && !a.style.fill && !a.style.stroke) return;
        this.paintPath(segments(a.segments, a.closed), a, out, res, alpha * (a.blend?.opacity ?? 1));
        return;
      case "raster":
        this.raster(a, out, res, alpha * (a.blend?.opacity ?? 1));
        return;
      case "text":
        this.text(a, out, res, alpha);
        return;
      case "mesh":
        this.mesh(a, out, res, alpha * (a.blend?.opacity ?? 1));
        return;
    }
  }

  private paintPath(d: string, a: PathArt, out: ByteWriter, res: PageRes, alpha: number): void {
    const st = a.style;
    const op = alpha * st.blend.opacity;
    const evenodd = st.fillRule === "evenodd";
    out.str("q\n");
    if (op < 1 || st.blend.mode !== "normal") out.str(`/${this.gs(res, op, op, st.blend.mode)} gs\n`);
    const solid = (p: Paint | null, stroke: boolean): string | null => {
      if (!p) return null;
      if (p.type === "color") return `${toRgb(p.color).map(f).join(" ")} ${stroke ? "RG" : "rg"}\n`;
      if (p.type === "pattern") return `0.5 0.5 0.5 ${stroke ? "RG" : "rg"}\n`;
      return null;
    };
    if (st.fill?.type === "gradient") {
      const def = this.doc.gradients.get(st.fill.name);
      if (def) {
        out.str("q\n" + d + (evenodd ? "W* n\n" : "W n\n"));
        this.shading(st.fill, def, out, res, op);
        out.str("Q\n");
      }
    } else if (st.fill) {
      out.str(solid(st.fill, false) ?? "");
    }
    const strokeOp = solid(st.stroke, true);
    if (strokeOp) {
      const s = st.strokeStyle;
      out.str(strokeOp + `${f(s.width)} w ${["butt", "round", "square"].indexOf(s.cap)} J ${["miter", "round", "bevel"].indexOf(s.join)} j ${f(Math.max(1, s.miterLimit))} M [${s.dash.map(f).join(" ")}] ${f(s.dashOffset)} d\n`);
    }
    const fills = st.fill && st.fill.type !== "gradient";
    out.str(d);
    out.str(fills && strokeOp ? (evenodd ? "B*\n" : "B\n") : fills ? (evenodd ? "f*\n" : "f\n") : strokeOp ? "S\n" : "n\n");
    out.str("Q\n");
  }

  /** Paints a gradient with `sh` in the current clip; stop opacities become a soft mask. */
  private shading(p: GradientPaint, def: GradientDef, out: ByteWriter, res: PageRes, alpha: number): void {
    const stops = def.stops;
    if (!stops.length) return;
    const fn = (values: (s: (typeof stops)[number]) => number[]): number => {
      const parts: number[] = [];
      const bounds: number[] = [];
      const encode: number[] = [];
      for (let i = 0; i < stops.length - 1; i++) {
        const a = stops[i], b = stops[i + 1];
        const N = a.midpoint > 0 && a.midpoint < 1 ? Math.log(0.5) / Math.log(a.midpoint) : 1;
        const num = this.pdf.alloc();
        this.pdf.object(num, { FunctionType: 2, Domain: [0, 1], C0: values(a), C1: values(b), N });
        parts.push(num);
        if (i > 0) bounds.push(a.offset);
        encode.push(0, 1);
      }
      const num = this.pdf.alloc();
      if (parts.length === 0) {
        this.pdf.object(num, { FunctionType: 2, Domain: [0, 1], C0: values(stops[0]), C1: values(stops[0]), N: 1 });
        return num;
      }
      // Domain covers [first, last] stop offsets; Extend pads outside.
      this.pdf.object(num, { FunctionType: 3, Domain: [stops[0].offset, stops[stops.length - 1].offset], Functions: parts.map(ref), Bounds: bounds, Encode: encode });
      return num;
    };
    const radial = def.type === "radial";
    let coords: number[];
    if (p.unitVector) coords = radial ? [0, 0, 0, 0, 0, 1] : [0, 0, 1, 0];
    else {
      const rad = (p.angle * Math.PI) / 180;
      const [x, y] = p.origin;
      coords = radial ? [x, y, 0, x, y, p.length] : [x, y, x + p.length * Math.cos(rad), y + p.length * Math.sin(rad)];
    }
    const t0 = stops[0].offset, t1 = stops[stops.length - 1].offset;
    const adjust = (c: number[]): number[] => {
      if (radial) return [c[0], c[1], c[5] * t0, c[3], c[4], c[5] * t1];
      return [c[0] + (c[2] - c[0]) * t0, c[1] + (c[3] - c[1]) * t0, c[0] + (c[2] - c[0]) * t1, c[1] + (c[3] - c[1]) * t1];
    };
    const sh = this.pdf.alloc();
    this.pdf.object(sh, {
      ShadingType: radial ? 3 : 2,
      ColorSpace: name("DeviceRGB"),
      Coords: adjust(coords),
      Domain: [t0, t1],
      Function: ref(fn((s) => toRgb(s.color))),
      Extend: [true, true],
    });
    const key = `Sh${res.shadings.size}`;
    res.shadings.set(key, sh);
    const m = `${p.matrix.map(f).join(" ")} cm\n`;
    if (stops.some((s) => s.opacity < 1)) {
      const ash = this.pdf.alloc();
      this.pdf.object(ash, {
        ShadingType: radial ? 3 : 2,
        ColorSpace: name("DeviceGray"),
        Coords: adjust(coords),
        Domain: [t0, t1],
        Function: ref(fn((s) => [s.opacity])),
        Extend: [true, true],
      });
      const form = this.pdf.alloc();
      const formContent = `${m}/Sh0 sh\n`;
      this.pdf.stream(form, { Type: name("XObject"), Subtype: name("Form"), BBox: [-1e5, -1e5, 1e5, 1e5], Group: { S: name("Transparency"), CS: name("DeviceGray") }, Resources: { Shading: { Sh0: ref(ash) } } }, new TextEncoder().encode(formContent));
      const smask = this.pdf.alloc();
      this.pdf.object(smask, { Type: name("Mask"), S: name("Luminosity"), G: ref(form) });
      out.str(`/${this.gs(res, alpha, alpha, "normal", smask)} gs\n`);
    } else if (alpha < 1) out.str(`/${this.gs(res, alpha, alpha, "normal")} gs\n`);
    out.str(m + `/${key} sh\n`);
  }

  private raster(a: RasterArt, out: ByteWriter, res: PageRes, alpha: number): void {
    const key = `${a.dataRange?.[0]}`;
    let num = this.images.get(key);
    if (num === undefined) {
      const img = rasterToPlanes(a, this.doc.source, this.opts.maxImageSize);
      if (!img) return;
      let smask: number | undefined;
      if (img.alpha) {
        smask = this.pdf.alloc();
        this.pdf.stream(smask, { Type: name("XObject"), Subtype: name("Image"), Width: img.width, Height: img.height, ColorSpace: name("DeviceGray"), BitsPerComponent: 8, Filter: name("FlateDecode") }, deflate(img.alpha, this.opts.level));
      }
      num = this.pdf.alloc();
      this.pdf.stream(num, { Type: name("XObject"), Subtype: name("Image"), Width: img.width, Height: img.height, ColorSpace: name("DeviceRGB"), BitsPerComponent: 8, Filter: name("FlateDecode"), SMask: smask ? ref(smask) : undefined }, deflate(img.rgb, this.opts.level));
      this.images.set(key, num);
    }
    const k = `Im${res.xobjects.size}`;
    res.xobjects.set(k, num);
    const [ma, mb, mc, md, tx, ty] = a.matrix;
    const w = a.width, h = a.height;
    out.str("q\n");
    if (alpha < 1) out.str(`/${this.gs(res, alpha, alpha, "normal")} gs\n`);
    out.str(`${[ma * w, mb * w, mc * h, md * h, tx - mc * h, ty - md * h].map(f).join(" ")} cm /${k} Do\nQ\n`);
  }

  private text(a: TextArt, out: ByteWriter, res: PageRes, alpha: number): void {
    const td: TextDocument | undefined = a.undoFree ? this.doc.undoFreeText : this.doc.text;
    const story = td?.stories[a.storyIndex];
    if (!td || !story) return;
    const frame = td.frames[story.frameIds[a.frameIndex] ?? story.frameIds[0]];
    if (!frame) return;
    res.font = true;
    for (const line of story.lines.filter((l) => l.frameId === frame.id)) {
      const text = story.text.slice(line.start, line.start + line.length).replace(/[\r\n\u0003]+$/, "");
      if (!text) continue;
      const run = story.chars.find((r) => r.start <= line.start && r.start + r.length > line.start) ?? story.chars[0];
      const cs = run?.style;
      const size = cs?.size ?? 12;
      const [x0, y0] = textToArt(td, frame, line.x, line.y);
      const [x1, y1] = textToArt(td, frame, line.x + 1, line.y);
      const [x2, y2] = textToArt(td, frame, line.x, line.y - 1);
      const color = paintRgb(cs?.fill ?? null);
      out.str("q\n");
      if (alpha < 1) out.str(`/${this.gs(res, alpha, alpha, "normal")} gs\n`);
      const tracking = ((cs?.tracking ?? 0) / 1000) * size;
      out.str(`BT /F1 ${f(size)} Tf ${f(tracking)} Tc ${color.map(f).join(" ")} rg ${[x1 - x0, y1 - y0, x2 - x0, y2 - y0, x0, y0].map(f).join(" ")} Tm ${winAnsi(text)} Tj ET\nQ\n`);
    }
  }

  private mesh(a: MeshArt, out: ByteWriter, res: PageRes, alpha: number): void {
    out.str("q\n");
    if (alpha < 1 || (a.blend && a.blend.mode !== "normal")) out.str(`/${this.gs(res, alpha, alpha, a.blend?.mode ?? "normal")} gs\n`);
    for (const { quad, color } of tessellateMesh(a, 6)) {
      const rgb = a.colorSpace === "DeviceCMYK" ? toRgb({ kind: "cmyk", c: color[0], m: color[1], y: color[2], k: color[3] }) : a.colorSpace === "DeviceGray" ? [color[0], color[0], color[0]] : color.slice(0, 3);
      out.str(`${rgb.map(f).join(" ")} rg ${rgb.map(f).join(" ")} RG 0.5 w ${quad.map((p, i) => `${f(p[0])} ${f(p[1])} ${i ? "l" : "m"}`).join(" ")} h B\n`);
    }
    out.str("Q\n");
  }
}

function segments(segs: PathSegment[], closed: boolean): string {
  let d = "";
  for (const s of segs) {
    if (s.kind === "move") d += `${f(s.x)} ${f(s.y)} m `;
    else if (s.kind === "line") d += `${f(s.x)} ${f(s.y)} l `;
    else d += `${f(s.x1!)} ${f(s.y1!)} ${f(s.x2!)} ${f(s.y2!)} ${f(s.x)} ${f(s.y)} c `;
  }
  return d + (closed ? "h\n" : "\n");
}

function paintRgb(p: TextPaint | null): number[] {
  if (!p) return [0, 0, 0];
  if (p.space === "rgb") return p.values.slice(0, 3);
  if (p.space === "cmyk") return toRgb({ kind: "cmyk", c: p.values[0], m: p.values[1], y: p.values[2], k: p.values[3] });
  return [p.values[0], p.values[0], p.values[0]];
}

const WIN_ANSI_EXTRA: Record<number, number> = { 0x20ac: 0x80, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2013: 0x96, 0x2014: 0x97, 0x2026: 0x85, 0x2022: 0x95 };

function winAnsi(text: string): string {
  let out = "(";
  for (const ch of text) {
    let c = ch.codePointAt(0)!;
    if (c > 0xff) c = WIN_ANSI_EXTRA[c] ?? 0x3f;
    const s = String.fromCharCode(c);
    if (s === "(" || s === ")" || s === "\\") out += "\\" + s;
    else if (c < 0x20 || c > 0x7e) out += "\\" + c.toString(8).padStart(3, "0");
    else out += s;
  }
  return out + ")";
}

