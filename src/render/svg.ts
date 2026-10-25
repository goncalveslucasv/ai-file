// Reference SVG renderer for the native model. Useful to preview a document and to check the
// interpretation of the native stream against Illustrator's own PDF rendition.
//
// Coverage: paths & compound paths (solid / linear / radial gradients, strokes, dashes, fill
// rules), groups with opacity and blend modes, clip groups, embedded rasters with alpha, point
// text (from the composed layout in the text document), gradient meshes (Coons patches,
// approximated by subdivision). Live effects are shown through the expanded result art
// Illustrator stores next to the editable source.

import { colorCss, rgbHex, toRgb } from "../model/color.ts";
import type { AiDocument, Art, GradientDef, GradientPaint, MeshArt, Paint, PathArt, PathStyle, RasterArt, TextArt } from "../model/types.ts";
import type { TextDocument, TextPaint } from "../text/txt2.ts";
import { tessellateMesh } from "./mesh.ts";
import { bytesToBase64, encodePng, rasterToRgba } from "./png.ts";

export interface SvgOptions {
  /** Longest side for embedded images (default 2048). */
  maxImageSize?: number;
  /** Render the editable source art instead of the expanded result (effects are not applied). */
  preferSource?: boolean;
  /** Resolves an image to an href instead of embedding a PNG data URI. */
  imageHref?: (art: RasterArt) => string | null;
  /** Mesh subdivision per patch side (default 8). */
  meshSteps?: number;
  /** Add a white page background (default true). */
  background?: string | null;
}

const f = (n: number): string => {
  if (!Number.isFinite(n)) return "0";
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
};
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function pathData(art: PathArt): string {
  const parts: string[] = [];
  for (const s of art.segments) {
    if (s.kind === "move") parts.push(`M${f(s.x)} ${f(s.y)}`);
    else if (s.kind === "line") parts.push(`L${f(s.x)} ${f(s.y)}`);
    else parts.push(`C${f(s.x1!)} ${f(s.y1!)} ${f(s.x2!)} ${f(s.y2!)} ${f(s.x)} ${f(s.y)}`);
  }
  if (art.closed) parts.push("Z");
  return parts.join("");
}

const BLEND_CSS: Record<string, string> = {
  normal: "",
  "soft-light": "soft-light",
  "hard-light": "hard-light",
  "color-dodge": "color-dodge",
  "color-burn": "color-burn",
};

class SvgBuilder {
  readonly doc: AiDocument;
  readonly opts: Required<Omit<SvgOptions, "imageHref" | "background">> & Pick<SvgOptions, "imageHref" | "background">;
  defs: string[] = [];
  private uid = 0;
  private imageCache = new Map<number, string>();

  constructor(doc: AiDocument, opts: SvgOptions) {
    this.doc = doc;
    this.opts = { maxImageSize: 2048, preferSource: false, meshSteps: 8, ...opts };
  }

  id(prefix: string): string {
    return `${prefix}${++this.uid}`;
  }

  paint(p: Paint | null, opacityOut: { v: number }): string {
    if (!p) return "none";
    if (p.type === "color") return colorCss(p.color);
    if (p.type === "gradient") {
      const def = this.doc.gradients.get(p.name);
      if (!def) return "#808080";
      return `url(#${this.gradient(p, def)})`;
    }
    opacityOut.v *= 1;
    return "#808080"; // patterns: neutral placeholder
  }

  gradient(p: GradientPaint, def: GradientDef): string {
    const id = this.id("g");
    const [a, b, c, d, e, ff] = p.matrix;
    const stops: string[] = [];
    const st = def.stops;
    const stopTag = (offset: number, rgb: [number, number, number], opacity: number): string =>
      `<stop offset="${f(offset)}" stop-color="${rgbHex(rgb)}"${opacity < 1 ? ` stop-opacity="${f(opacity)}"` : ""}/>`;
    st.forEach((s, i) => {
      const ca = toRgb(s.color);
      stops.push(stopTag(s.offset, ca, s.opacity));
      const next = st[i + 1];
      if (!next || Math.abs(s.midpoint - 0.5) < 0.01 || s.midpoint <= 0 || s.midpoint >= 1) return;
      // Illustrator's midpoint is an exponent on the segment parameter: v(t) = t^N, N = ln 0.5 / ln midpoint.
      const N = Math.log(0.5) / Math.log(s.midpoint);
      const cb = toRgb(next.color);
      for (let k = 1; k < 8; k++) {
        const t = k / 8;
        const v = Math.pow(t, N);
        const mix = (x: number, y: number): number => x + (y - x) * v;
        stops.push(stopTag(s.offset + (next.offset - s.offset) * t, [mix(ca[0], cb[0]), mix(ca[1], cb[1]), mix(ca[2], cb[2])], mix(s.opacity, next.opacity)));
      }
    });
    const tr = `gradientTransform="matrix(${[a, b, c, d, e, ff].map(f).join(" ")})"`;
    // Unit vector in Xm space, or legacy origin/angle/length in Bg-matrix space.
    let [x1, y1, x2, y2] = [0, 0, 1, 0];
    if (!p.unitVector) {
      const rad = (p.angle * Math.PI) / 180;
      [x1, y1] = p.origin;
      x2 = x1 + p.length * Math.cos(rad);
      y2 = y1 + p.length * Math.sin(rad);
    }
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (def.type === "linear") {
      this.defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" ${tr}>${stops.join("")}</linearGradient>`);
    } else {
      // Bh: highlight offset (x, y) relative to the center, in gradient space.
      const hl = p.highlight;
      const fx = hl ? x1 + hl[0] : x1;
      const fy = hl ? y1 + hl[1] : y1;
      this.defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${f(x1)}" cy="${f(y1)}" r="${f(len)}" fx="${f(fx)}" fy="${f(fy)}" ${tr}>${stops.join("")}</radialGradient>`);
    }
    return id;
  }

  styleAttrs(style: PathStyle, extraOpacity = 1): string {
    const op = { v: 1 };
    const fill = this.paint(style.fill, op);
    const stroke = this.paint(style.stroke, op);
    let s = `fill="${fill}"`;
    if (style.fill && style.fillRule === "evenodd") s += ` fill-rule="evenodd"`;
    if (style.stroke) {
      const ss = style.strokeStyle;
      s += ` stroke="${stroke}" stroke-width="${f(ss.width)}"`;
      if (ss.cap !== "butt") s += ` stroke-linecap="${ss.cap}"`;
      if (ss.join !== "miter") s += ` stroke-linejoin="${ss.join}"`;
      else if (ss.miterLimit !== 4) s += ` stroke-miterlimit="${f(Math.max(1, ss.miterLimit))}"`;
      if (ss.dash.length) s += ` stroke-dasharray="${ss.dash.map(f).join(" ")}" stroke-dashoffset="${f(ss.dashOffset)}"`;
    }
    const opacity = style.blend.opacity * extraOpacity * op.v;
    if (opacity < 1) s += ` opacity="${f(opacity)}"`;
    const mode = style.blend.mode;
    if (mode !== "normal") s += ` style="mix-blend-mode:${BLEND_CSS[mode] ?? mode}"`;
    return s;
  }

  art(a: Art): string {
    if (a.hidden) return "";
    if (this.opts.preferSource && a.source?.length) return a.source.map((x) => this.art(x)).join("");
    switch (a.type) {
      case "layer":
        if (!a.visible) return "";
        return `<g data-layer="${esc(a.layerName)}">${a.children.map((c) => this.art(c)).join("")}</g>`;
      case "group":
        return this.group(a.children, a.clipGroup, a.blend);
      case "compound": {
        const first = a.children[0];
        if (!first) return "";
        const d = a.children.map(pathData).join("");
        return `<path d="${d}" ${this.styleAttrs({ ...first.style, fillRule: first.style.fillRule })}${blendStyle(a.blend)}/>`;
      }
      case "path":
        if (a.clip && a.style.fill === null && a.style.stroke === null) return "";
        return `<path d="${pathData(a)}" ${this.styleAttrs(a.style)}${blendStyle(a.blend)}/>`;
      case "raster":
        return this.raster(a);
      case "text":
        return this.text(a);
      case "mesh":
        return this.mesh(a);
      default:
        return "";
    }
  }

  group(children: Art[], clip: boolean, blend: Art["blend"]): string {
    let inner: string;
    let clipAttr = "";
    if (clip) {
      const clips = children.filter((c) => (c.type === "path" && c.clip) || (c.type === "compound" && c.children.some((p) => p.clip)));
      const rest = children.filter((c) => !clips.includes(c));
      if (clips.length) {
        const id = this.id("c");
        const shapes = clips
          .map((c) => (c.type === "path" ? `<path d="${pathData(c)}"${c.style.fillRule === "evenodd" ? ' clip-rule="evenodd"' : ""}/>` : c.type === "compound" ? `<path d="${c.children.map(pathData).join("")}"/>` : ""))
          .join("");
        this.defs.push(`<clipPath id="${id}">${shapes}</clipPath>`);
        clipAttr = ` clip-path="url(#${id})"`;
      }
      inner = rest.map((c) => this.art(c)).join("");
    } else inner = children.map((c) => this.art(c)).join("");
    if (!inner) return "";
    let attrs = clipAttr;
    if (blend && blend.opacity < 1) attrs += ` opacity="${f(blend.opacity)}"`;
    if (blend && blend.mode !== "normal") attrs += ` style="mix-blend-mode:${BLEND_CSS[blend.mode] ?? blend.mode}${blend.isolated ? ";isolation:isolate" : ""}"`;
    return `<g${attrs}>${inner}</g>`;
  }

  raster(a: RasterArt): string {
    let href = this.opts.imageHref?.(a) ?? null;
    if (!href) {
      href = this.imageCache.get(a.dataRange?.[0] ?? -1) ?? null;
      if (!href) {
        const img = rasterToRgba(a, this.doc.source, this.opts.maxImageSize);
        if (!img) return "";
        href = `data:image/png;base64,${bytesToBase64(encodePng(img.rgba, img.width, img.height))}`;
        if (a.dataRange) this.imageCache.set(a.dataRange[0], href);
      }
    }
    const [ma, mb, mc, md, tx, ty] = a.matrix;
    // Image space has v pointing down: art = (tx + a*u - c*v, ty + b*u - d*v).
    return `<image width="${a.width}" height="${a.height}" preserveAspectRatio="none" transform="matrix(${[ma, mb, -mc, -md, tx, ty].map(f).join(" ")})" href="${href}"${blendStyle(a.blend)}/>`;
  }

  text(a: TextArt): string {
    const td = a.undoFree ? this.doc.undoFreeText : this.doc.text;
    if (!td) return "";
    const story = td.stories[a.storyIndex];
    if (!story) return "";
    const frameId = story.frameIds[a.frameIndex] ?? story.frameIds[0];
    const frame = td.frames[frameId];
    if (!frame) return "";
    const lines = story.lines.filter((l) => l.frameId === frameId);
    const out: string[] = [];
    for (const line of lines) {
      const text = story.text.slice(line.start, line.start + line.length).replace(/[\r\n\u0003]+$/, "");
      if (!text) continue;
      const runs = story.chars.filter((r) => r.start < line.start + text.length && r.start + r.length > line.start);
      const tspans: string[] = [];
      for (const r of runs) {
        const s = Math.max(r.start, line.start) - line.start;
        const e = Math.min(r.start + r.length, line.start + text.length) - line.start;
        const chunk = text.slice(s, e);
        if (!chunk) continue;
        const cs = r.style;
        const xs = line.positions.length > e - 1 ? Array.from(chunk, (_, k) => f(line.x + line.positions[s + k])).join(" ") : undefined;
        const font = cs.font?.postScriptName ?? "";
        const { family, weight, italic } = fontInfo(font);
        tspans.push(
          `<tspan${xs ? ` x="${xs}"` : ""} font-family="${esc(family)}" font-size="${f(cs.size)}"${weight !== 400 ? ` font-weight="${weight}"` : ""}${italic ? ' font-style="italic"' : ""} fill="${textPaint(cs.fill)}"${cs.stroke ? ` stroke="${textPaint(cs.stroke)}" stroke-width="${f(cs.strokeWidth)}"` : ""}>${esc(chunk)}</tspan>`,
        );
      }
      if (!line.positions.length && frame.kind === "point") {
        // No composed glyph positions (text edited outside Illustrator): align on the frame anchor.
        const just = story.paragraphs[0]?.style.justification ?? 0;
        const anchor = just === 2 ? "middle" : just === 1 ? "end" : "start";
        out.push(`<text x="${f(frame.anchor[0])}" y="${f(line.y)}" text-anchor="${anchor}" xml:space="preserve">${tspans.join("")}</text>`);
        continue;
      }
      out.push(`<text x="${f(line.x)}" y="${f(line.y)}" xml:space="preserve">${tspans.join("")}</text>`);
    }
    if (!out.length) return "";
    const [ra, rb, rc, rd, re, rf] = frame.matrix;
    return `<g transform="matrix(1 0 0 -1 ${f(-td.rulerOrigin[0])} ${f(td.rulerOrigin[1])}) matrix(${[ra, rb, rc, rd, re, rf].map(f).join(" ")})">${out.join("")}</g>`;
  }

  mesh(a: MeshArt): string {
    const polys = tessellateMesh(a, this.opts.meshSteps).map(({ quad, color }) => {
      const c = meshCss(a.colorSpace, color);
      return `<path d="M${quad.map((p) => `${f(p[0])} ${f(p[1])}`).join("L")}Z" fill="${c}" stroke="${c}" stroke-width="0.5"/>`;
    });
    return polys.length ? `<g${blendStyle(a.blend)}>${polys.join("")}</g>` : "";
  }
}

function meshCss(space: string, c: number[]): string {
  if (space === "DeviceCMYK") return colorCss({ kind: "cmyk", c: c[0], m: c[1], y: c[2], k: c[3] });
  if (space === "DeviceGray") return colorCss({ kind: "gray", gray: c[0] });
  return rgbHex([c[0], c[1], c[2]]);
}

function blendStyle(blend: Art["blend"]): string {
  if (!blend) return "";
  let s = "";
  if (blend.opacity < 1) s += ` opacity="${f(blend.opacity)}"`;
  if (blend.mode !== "normal") s += ` style="mix-blend-mode:${BLEND_CSS[blend.mode] ?? blend.mode}"`;
  return s;
}

function textPaint(p: TextPaint | null): string {
  if (!p) return "none";
  if (p.space === "rgb") return rgbHex([p.values[0], p.values[1], p.values[2]]);
  if (p.space === "cmyk") return colorCss({ kind: "cmyk", c: p.values[0], m: p.values[1], y: p.values[2], k: p.values[3] });
  return colorCss({ kind: "gray", gray: p.values[0] });
}

const WEIGHTS: [RegExp, number][] = [
  [/thin|hairline/i, 100],
  [/extra ?light|ultra ?light/i, 200],
  [/light/i, 300],
  [/medium/i, 500],
  [/semi ?bold|demi ?bold/i, 600],
  [/extra ?bold|ultra ?bold/i, 800],
  [/black|heavy/i, 900],
  [/bold/i, 700],
];

/** Splits a PostScript font name ("Syne-Bold") into CSS family / weight / style. */
export function fontInfo(psName: string): { family: string; weight: number; italic: boolean } {
  const [fam, style = ""] = psName.split("-");
  const family = fam.replace(/(PSMT|MT|PS)$/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
  let weight = 400;
  for (const [re, w] of WEIGHTS) {
    if (re.test(style)) {
      weight = w;
      break;
    }
  }
  return { family: `${family}, ${psName}, sans-serif`, weight, italic: /italic|oblique/i.test(style) };
}

/** Renders one artboard (0-based index) to a standalone SVG document. */
export function renderArtboardSvg(doc: AiDocument, artboardIndex = 0, options: SvgOptions = {}): string {
  const ab = doc.artboards[artboardIndex];
  if (!ab) throw new Error(`No artboard ${artboardIndex}`);
  const b = new SvgBuilder(doc, options);
  const w = ab.right - ab.left;
  const h = ab.top - ab.bottom;
  const body = doc.layers.map((l) => b.art(l)).join("");
  const bg = options.background === undefined ? "#ffffff" : options.background;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${f(w)}" height="${f(h)}" viewBox="0 0 ${f(w)} ${f(h)}">` +
    (bg ? `<rect width="100%" height="100%" fill="${bg}"/>` : "") +
    `<defs>${b.defs.join("")}</defs>` +
    `<g transform="matrix(1 0 0 -1 ${f(-ab.left)} ${f(ab.top)})">${body}</g></svg>`
  );
}

export type { TextDocument };
