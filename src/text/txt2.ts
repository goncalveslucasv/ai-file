// Illustrator text documents (%AI11_BeginTextDocument).
//
// The payload is ASCII85-encoded "Txt2" data: the same PostScript-like syntax Photoshop uses
// for EngineData, but with numeric keys ("/0", "/1", ... "/99") instead of names. The key
// meanings below were recovered by correlating the data with the PDF rendition of the same
// document (font names, sizes, positions and colors match exactly):
//
// root
//   /0  document resources
//       /1 /0 [ { /0 { /99 /CoolTypeFont /0 { /0 (PostScript name) /2 type /5 (version) } } } ]  font list
//       /5 /0 [...] character style sheets ([Normal Character Style] first)
//       /6 /0 [...] paragraph style sheets ([Normal Paragraph Style] first)
//       /8 /0 [ { /0 { /97 (uuid) /0 [x y] /2 { /2 [a b c d tx ty] } } } ]  text frames
//   /1  stories container
//       /2  default character features    /3 default paragraph features
//       /1 [ story ... ]
//          story /0 /0 (text, "\r" separates paragraphs)
//                /0 /5 /0 [ { /0 {/0 {/5 parafeatures}} /1 runLength } ]   paragraph runs
//                /0 /6 /0 [ { /0 {/0 {/6 charfeatures}} /1 runLength } ]   character runs
//                /1 /0 [ { /0 frameId } ]                                 frames showing the story
//                /1 /2 [...]  composed layout: /PC > /F (frame) > /R > /R > /L (line) > /S > /G (glyph run)
//
// Character features: /0 font index, /1 size, /2 faux bold, /3 faux italic, /4 auto leading,
//   /5 leading, /6 horizontal scale, /7 vertical scale, /8 tracking (1/1000 em), /9 baseline shift,
//   /53 fill paint, /54 stroke paint, /56 fill enabled, /57 stroke enabled, /63 stroke width.
// Paint: { /99 /SimplePaint|/CAITextPaint /0 { /0 colorType /1 [alpha c1 c2 c3 (c4)] } /5 (art style) }.
//
// Text space has y pointing DOWN. A point in text space maps to art space (y up) through the
// frame matrix and the document ruler origin R stored next to the payload:
//   (x', y') = frameMatrix · (x, y);   art = (x' - R.x, R.y - y').

import { latin1 } from "../bytes.ts";
import type { Matrix } from "../model/types.ts";

export interface T2Raw {
  /** A byte string without the UTF-16 BOM (uuids, bit masks...). */
  raw: string;
}
export interface T2Name {
  name: string;
}
export type T2Value = number | boolean | string | T2Raw | T2Name | T2Value[] | T2Dict;
export type T2Dict = Map<string, T2Value>;

// ----------------------------------------------------------------------------- generic syntax

export function parseTxt2(bytes: Uint8Array): T2Dict {
  let pos = 0;
  const n = bytes.length;
  const isWs = (c: number): boolean => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x00;
  const isDelim = (c: number): boolean => c === 0x2f || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x28 || c === 0x29;
  const skip = (): void => {
    while (pos < n && isWs(bytes[pos])) pos++;
  };
  const word = (): string => {
    const s = pos;
    while (pos < n && !isWs(bytes[pos]) && !isDelim(bytes[pos])) pos++;
    return latin1(bytes, s, pos);
  };
  const value = (): T2Value => {
    skip();
    const c = bytes[pos];
    if (c === 0x3c && bytes[pos + 1] === 0x3c) {
      pos += 2;
      const d: T2Dict = new Map();
      for (;;) {
        skip();
        if (pos >= n) break;
        if (bytes[pos] === 0x3e && bytes[pos + 1] === 0x3e) {
          pos += 2;
          break;
        }
        if (bytes[pos] !== 0x2f) throw new Error(`Txt2: key expected at ${pos}`);
        pos++;
        const key = word();
        d.set(key, value());
      }
      return d;
    }
    if (c === 0x5b) {
      pos++;
      const arr: T2Value[] = [];
      for (;;) {
        skip();
        if (pos >= n || bytes[pos] === 0x5d) {
          pos++;
          break;
        }
        arr.push(value());
      }
      return arr;
    }
    if (c === 0x28) {
      pos++;
      let s = "";
      while (pos < n) {
        const ch = bytes[pos++];
        if (ch === 0x5c) {
          const e = bytes[pos++];
          if (e === 0x6e) s += "\n";
          else if (e === 0x72) s += "\r";
          else if (e === 0x74) s += "\t";
          else s += String.fromCharCode(e);
          continue;
        }
        if (ch === 0x29) break;
        s += String.fromCharCode(ch);
      }
      if (s.charCodeAt(0) === 0xfe && s.charCodeAt(1) === 0xff) {
        let out = "";
        for (let i = 2; i + 1 < s.length; i += 2) out += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
        return out;
      }
      return { raw: s };
    }
    if (c === 0x2f) {
      pos++;
      return { name: word() };
    }
    const w = word();
    if (w === "true") return true;
    if (w === "false") return false;
    const num = Number(w);
    if (w === "" || Number.isNaN(num)) throw new Error(`Txt2: unexpected token "${w}" at ${pos}`);
    return num;
  };
  const root: T2Dict = new Map();
  for (;;) {
    skip();
    if (pos >= n) break;
    if (bytes[pos] !== 0x2f) throw new Error(`Txt2: top-level key expected at ${pos}`);
    pos++;
    const key = word();
    root.set(key, value());
  }
  return root;
}

export function writeTxt2(root: T2Dict): string {
  const out: string[] = [];
  const num = (v: number): string => {
    if (Number.isInteger(v)) return String(v);
    let s = v.toFixed(5).replace(/0+$/, "");
    if (s.endsWith(".")) s += "0";
    return s.replace(/^(-?)0\./, "$1.");
  };
  const str = (bytes: string): string => "(" + bytes.replace(/[\\()]/g, (c) => "\\" + c) + ")";
  const write = (v: T2Value): void => {
    if (typeof v === "number") out.push(num(v));
    else if (typeof v === "boolean") out.push(v ? "true" : "false");
    else if (typeof v === "string") {
      let b = "\xfe\xff";
      for (let i = 0; i < v.length; i++) {
        const c = v.charCodeAt(i);
        b += String.fromCharCode(c >> 8, c & 0xff);
      }
      out.push(str(b));
    } else if (Array.isArray(v)) {
      out.push("[");
      v.forEach((x) => write(x));
      out.push("]");
    } else if (v instanceof Map) {
      out.push("<<");
      for (const [k, x] of v) {
        out.push("/" + k);
        write(x);
      }
      out.push(">>");
    } else if ("raw" in v) out.push(str(v.raw));
    else out.push("/" + v.name);
  };
  for (const [k, v] of root) {
    out.push("/" + k);
    write(v);
  }
  return " " + out.join(" ");
}

// ----------------------------------------------------------------------------- typed view

export const get = (v: T2Value | undefined, ...path: (string | number)[]): T2Value | undefined => {
  let cur = v;
  for (const p of path) {
    if (cur instanceof Map) cur = cur.get(String(p));
    else if (Array.isArray(cur) && typeof p === "number") cur = cur[p];
    else return undefined;
  }
  return cur;
};
const num = (v: T2Value | undefined, def = 0): number => (typeof v === "number" ? v : def);
const arr = (v: T2Value | undefined): T2Value[] => (Array.isArray(v) ? v : []);
const nums = (v: T2Value | undefined): number[] => arr(v).map((x) => num(x));

export interface TextFont {
  postScriptName: string;
  /** CoolType font type (0 OpenType CFF, 1 TrueType...). */
  fontType: number;
  version?: string;
}

export interface TextPaint {
  /** RGB 0..1, CMYK 0..1 or gray 0..1 depending on `space`. */
  space: "rgb" | "cmyk" | "gray";
  values: number[];
  alpha: number;
  /** Art style backing the paint (/5), if any. */
  styleName?: string;
}

export interface CharStyle {
  fontIndex: number;
  font?: TextFont;
  size: number;
  fauxBold: boolean;
  fauxItalic: boolean;
  autoLeading: boolean;
  leading: number;
  horizontalScale: number;
  verticalScale: number;
  /** 1/1000 em. */
  tracking: number;
  baselineShift: number;
  fill: TextPaint | null;
  stroke: TextPaint | null;
  strokeWidth: number;
}

export interface ParagraphStyle {
  /** 0 left, 1 right, 2 center, 3..6 justified variants. */
  justification: number;
  firstLineIndent: number;
  startIndent: number;
  endIndent: number;
  spaceBefore: number;
  spaceAfter: number;
  autoLeading: number;
}

export interface Run<T> {
  start: number;
  length: number;
  style: T;
  /** Raw feature dictionary of the run (overrides only). */
  features: T2Dict;
}

export interface TextLine {
  frameId: number;
  /** Index into the story text and number of characters (including the trailing "\r"). */
  start: number;
  length: number;
  /** Baseline origin in text space (before the frame matrix). */
  x: number;
  y: number;
  /** Glyph x positions relative to (x, y) — one more than the glyph count. */
  positions: number[];
  glyphIds: number[];
}

export interface TextFrame {
  id: number;
  uuid?: string;
  kind: "point" | "area" | "path";
  /** Point text anchor in text space. */
  anchor: [number, number];
  /** Frame matrix in text space. */
  matrix: Matrix;
  raw: T2Dict;
}

export interface TextStory {
  index: number;
  text: string;
  paragraphs: Run<ParagraphStyle>[];
  chars: Run<CharStyle>[];
  frameIds: number[];
  lines: TextLine[];
  raw: T2Dict;
}

export interface TextDocument {
  /** Decoded Txt2 tree (edit it and call `encodeTextDocument` to write it back). */
  root: T2Dict;
  rulerOrigin: [number, number];
  fonts: TextFont[];
  stories: TextStory[];
  frames: TextFrame[];
  defaultChar: CharStyle;
  defaultParagraph: ParagraphStyle;
}

function readPaint(v: T2Value | undefined): TextPaint | null {
  if (!(v instanceof Map)) return null;
  const c = get(v, "0");
  const type = num(get(c, "0"), 1);
  const values = nums(get(c, "1"));
  if (!values.length) return null;
  const alpha = values[0];
  const rest = values.slice(1);
  let space: TextPaint["space"] = type === 2 || rest.length === 4 ? "cmyk" : rest.length === 1 ? "gray" : "rgb";
  if (type === 0 && rest.length === 1) space = "gray";
  const style = get(v, "5");
  return { space, values: rest, alpha, styleName: typeof style === "string" ? style : undefined };
}

function charStyle(features: T2Value | undefined, base: CharStyle | undefined, fonts: TextFont[]): CharStyle {
  const f = features instanceof Map ? features : new Map<string, T2Value>();
  const pick = <T>(key: string, conv: (v: T2Value) => T, def: T): T => (f.has(key) ? conv(f.get(key)!) : def);
  const b = base;
  const fontIndex = pick("0", (v) => num(v), b?.fontIndex ?? 0);
  return {
    fontIndex,
    font: fonts[fontIndex],
    size: pick("1", (v) => num(v), b?.size ?? 12),
    fauxBold: pick("2", (v) => v === true, b?.fauxBold ?? false),
    fauxItalic: pick("3", (v) => v === true, b?.fauxItalic ?? false),
    autoLeading: pick("4", (v) => v === true, b?.autoLeading ?? true),
    leading: pick("5", (v) => num(v), b?.leading ?? 0),
    horizontalScale: pick("6", (v) => num(v, 1), b?.horizontalScale ?? 1),
    verticalScale: pick("7", (v) => num(v, 1), b?.verticalScale ?? 1),
    tracking: pick("8", (v) => num(v), b?.tracking ?? 0),
    baselineShift: pick("9", (v) => num(v), b?.baselineShift ?? 0),
    fill: f.has("56") && f.get("56") === false ? null : f.has("53") ? readPaint(f.get("53")) : (b?.fill ?? null),
    stroke: f.has("57") ? (f.get("57") === true ? readPaint(f.get("54")) : null) : (b?.stroke ?? null),
    strokeWidth: pick("63", (v) => num(v, 1), b?.strokeWidth ?? 1),
  };
}

function paragraphStyle(features: T2Value | undefined, base: ParagraphStyle | undefined): ParagraphStyle {
  const f = features instanceof Map ? features : new Map<string, T2Value>();
  const n = (k: string, def: number): number => (f.has(k) ? num(f.get(k)) : def);
  return {
    justification: n("0", base?.justification ?? 0),
    firstLineIndent: n("1", base?.firstLineIndent ?? 0),
    startIndent: n("2", base?.startIndent ?? 0),
    endIndent: n("3", base?.endIndent ?? 0),
    spaceBefore: n("4", base?.spaceBefore ?? 0),
    spaceAfter: n("5", base?.spaceAfter ?? 0),
    autoLeading: n("7", base?.autoLeading ?? 1.2),
  };
}

function collectLines(layout: T2Value | undefined, out: TextLine[], frameId: number, cursor: { pos: number }): void {
  if (Array.isArray(layout)) {
    for (const x of layout) collectLines(x, out, frameId, cursor);
    return;
  }
  if (!(layout instanceof Map)) return;
  const kind = get(layout, "99");
  const k = kind && typeof kind === "object" && "name" in kind ? kind.name : "";
  if (k === "F") frameId = num(get(layout, "10"), frameId);
  if (k === "L") {
    const strike = arr(get(layout, "6")).find((s) => s instanceof Map && (get(s, "99") as T2Name | undefined)?.name === "S");
    const length = num(get(strike, "15", "0"));
    const glyphs = arr(get(strike, "6")).filter((g) => g instanceof Map && (get(g, "99") as T2Name | undefined)?.name === "G");
    const g0 = glyphs[0];
    const bbox = nums(get(g0, "8"));
    const ext = nums(get(g0, "1"));
    const positions: number[] = [];
    const glyphIds: number[] = [];
    for (const g of glyphs) {
      const p = nums(get(g, "21", "1"));
      const base = nums(get(g, "8"))[0] - (bbox[0] ?? 0);
      for (const v of p) positions.push(v + base);
      glyphIds.push(...nums(get(g, "21", "0")));
    }
    out.push({
      frameId,
      start: cursor.pos,
      length,
      x: (bbox[0] ?? 0) - (ext[0] ?? 0),
      y: (bbox[1] ?? 0) - (ext[1] ?? 0),
      positions,
      glyphIds,
    });
    cursor.pos += length;
    return;
  }
  const children = get(layout, "6");
  if (children !== undefined) collectLines(children, out, frameId, cursor);
}

export function readTextDocument(root: T2Dict, rulerOrigin: [number, number]): TextDocument {
  const fonts: TextFont[] = arr(get(root, "0", "1", "0")).map((f) => {
    const d = get(f, "0", "0");
    const name = get(d, "0");
    const ver = get(d, "5");
    return { postScriptName: typeof name === "string" ? name : "", fontType: num(get(d, "2")), version: typeof ver === "string" ? ver : undefined };
  });
  const stories = get(root, "1");
  const charSheets = arr(get(root, "0", "5", "0"));
  const paraSheets = arr(get(root, "0", "6", "0"));
  const defaultChar = charStyle(get(charSheets[0], "0", "6"), charStyle(get(stories, "2"), undefined, fonts), fonts);
  const defaultParagraph = paragraphStyle(get(paraSheets[0], "0", "5"), paragraphStyle(get(stories, "3"), undefined));

  const frames: TextFrame[] = arr(get(root, "0", "8", "0")).map((entry, id) => {
    const d = get(entry, "0") as T2Dict;
    const anchor = nums(get(d, "0"));
    const m = nums(get(d, "2", "2"));
    const uuid = get(d, "97");
    const kind: TextFrame["kind"] = anchor.length === 2 ? "point" : get(d, "1") !== undefined ? "area" : "path";
    return {
      id,
      uuid: uuid && typeof uuid === "object" && "raw" in uuid ? uuid.raw : undefined,
      kind,
      anchor: [anchor[0] ?? 0, anchor[1] ?? 0],
      matrix: (m.length === 6 ? m : [1, 0, 0, 1, 0, 0]) as Matrix,
      raw: d instanceof Map ? d : new Map(),
    };
  });

  const storyList = arr(get(stories, "1")).map((s, index): TextStory => {
    const model = get(s, "0");
    const text = get(model, "0");
    const runs = <T>(list: T2Value | undefined, sheetKey: string, mk: (f: T2Value | undefined) => T): Run<T>[] => {
      let start = 0;
      return arr(get(list, "0")).map((r) => {
        const length = num(get(r, "1"));
        const feats = get(r, "0", "0", sheetKey);
        const run = { start, length, style: mk(feats), features: feats instanceof Map ? feats : new Map<string, T2Value>() };
        start += length;
        return run;
      });
    };
    const view = get(s, "1");
    const frameIds = arr(get(view, "0")).map((f) => num(get(f, "0")));
    const lines: TextLine[] = [];
    collectLines(get(view, "2"), lines, frameIds[0] ?? 0, { pos: 0 });
    const storyText = typeof text === "string" ? text : "";
    const covered = lines.reduce((n, l) => n + l.length, 0);
    const consistent = covered === storyText.length && lines.every((l) => l.glyphIds.length === 0 || l.glyphIds.length === l.length);
    if (!consistent && lines.length) {
      // Text edited outside Illustrator: the cached composition is stale. Keep the first baseline of
      // each frame and lay the whole text there without glyph positions.
      const first = new Map<number, TextLine>();
      for (const l of lines) if (!first.has(l.frameId)) first.set(l.frameId, l);
      lines.splice(0, lines.length, ...[...first.values()].map((l, i) => ({ ...l, start: 0, length: i === 0 ? storyText.length : 0, positions: [], glyphIds: [] })));
    }
    return {
      index,
      text: typeof text === "string" ? text : "",
      paragraphs: runs(get(model, "5"), "5", (f) => paragraphStyle(f, defaultParagraph)),
      chars: runs(get(model, "6"), "6", (f) => charStyle(f, defaultChar, fonts)),
      frameIds,
      lines,
      raw: s instanceof Map ? s : new Map(),
    };
  });

  return { root, rulerOrigin, fonts, stories: storyList, frames, defaultChar, defaultParagraph };
}

/** Maps a text-space point of `frame` to art space. */
export function textToArt(doc: TextDocument, frame: TextFrame, x: number, y: number): [number, number] {
  const [a, b, c, d, tx, ty] = frame.matrix;
  const px = a * x + c * y + tx;
  const py = b * x + d * y + ty;
  return [px - doc.rulerOrigin[0], doc.rulerOrigin[1] - py];
}

/**
 * Replaces the text of a story, keeping the style of the first character run for the whole
 * text. The cached layout (/1 /2) is left untouched; Illustrator recomposes text on open.
 */
export function setStoryText(doc: TextDocument, storyIndex: number, text: string): void {
  const story = doc.stories[storyIndex];
  if (!story) throw new Error(`No story ${storyIndex}`);
  const value = text.endsWith("\r") ? text : text + "\r";
  const model = get(story.raw, "0") as T2Dict;
  model.set("0", value);
  for (const key of ["5", "6"]) {
    const list = get(model, key, "0");
    if (Array.isArray(list) && list.length) {
      list.splice(1);
      (list[0] as T2Dict).set("1", value.length);
    }
  }
  story.text = value;
  // The cached composition no longer matches: keep each frame's first baseline, drop glyph positions.
  const firstPerFrame = new Map<number, TextLine>();
  for (const l of story.lines) if (!firstPerFrame.has(l.frameId)) firstPerFrame.set(l.frameId, l);
  story.lines = [...firstPerFrame.values()].map((l, i) => ({ ...l, start: 0, length: i === 0 ? value.length : 0, positions: [], glyphIds: [] }));
  story.chars = story.chars.slice(0, 1).map((r) => ({ ...r, start: 0, length: value.length }));
  story.paragraphs = story.paragraphs.slice(0, 1).map((r) => ({ ...r, start: 0, length: value.length }));
}
