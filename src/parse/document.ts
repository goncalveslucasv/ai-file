// Interprets the statements of a native Illustrator stream into an AiDocument.
//
// Grammar of the art section, as recovered from Illustrator 2026 output (see docs/FORMAT.md):
//
//   layer       := %AI5_BeginLayer  <Lb> (name) Ln [AE] [dict] art* LB %AI5_EndLayer--
//   art         := prefix* object trailer?
//   prefix      := A Xw Ae Ap As D O R <colors> Xy J j w M d XR Xd ...      (graphics state, sticky)
//   object      := path | u art* U | q art* Q | *u path* *U | raster | mesh | text
//   path        := (m|l|L|c|C|v|V|y|Y)+ [h] [W] (f|F|s|S|b|B|n|N)
//   raster      := %AI5_BeginRaster XG XN Xh XI<binary> XH [Xr] %AI5_EndRaster N
//   mesh        := /Mesh X! ( ... X# )* /End X!
//   text        := /AI11Text : ... ;
//   trailer     := [dict] [Xy Xd] code (styleName) XW
//
// Objects with a complex appearance (effects, several fills...) are written twice: first the
// expanded result (what a PostScript printer draws), then, inside "%_" regions, the editable
// source object, closed by a *visible* "code (styleName) XW". The model keeps the result as the
// art node and attaches the source as `art.source`.

import { decodeMaybeUtf8 } from "../bytes.ts";
import { colorFromOperator } from "../model/color.ts";
import {
  BLEND_MODES,
  type AiDocument,
  type AiHeader,
  type Art,
  type ArtBase,
  type Artboard,
  type ArtStyle,
  type BlendStyle,
  type Color,
  type CompoundPathArt,
  type GradientDef,
  type GradientPaint,
  type GroupArt,
  type LayerArt,
  type Matrix,
  type MeshArt,
  type Paint,
  type PathArt,
  type PathSegment,
  type PathStyle,
  type RasterArt,
  type StrokeStyle,
  type Swatch,
  type TextArt,
  type UnknownArt,
} from "../model/types.ts";
import { entryValue, findEntry, findEntryDeep, getNode, getValue, parseDictBlock, type DictNode } from "../syntax/dict.ts";
import { isArr, isName, isStr, lex, type Operand, type Statement } from "../syntax/lexer.ts";
import { parseTxt2, readTextDocument } from "../text/txt2.ts";

// ----------------------------------------------------------------------------- graphics state

export interface GState {
  fill: Paint | null;
  stroke: Paint | null;
  strokeStyle: StrokeStyle;
  fillRule: "nonzero" | "evenodd";
  fillOverprint: boolean;
  strokeOverprint: boolean;
  blend: BlendStyle;
  xd?: [number, number];
}

export function defaultGState(): GState {
  return {
    fill: { type: "color", color: { kind: "gray", gray: 0 } },
    stroke: null,
    strokeStyle: { width: 1, cap: "butt", join: "miter", miterLimit: 10, dash: [], dashOffset: 0 },
    fillRule: "nonzero",
    fillOverprint: false,
    strokeOverprint: false,
    blend: { mode: "normal", opacity: 1, isolated: false, knockout: 0, alphaIsShape: false },
  };
}

export function cloneGState(g: GState): GState {
  return {
    ...g,
    strokeStyle: { ...g.strokeStyle, dash: [...g.strokeStyle.dash] },
    blend: { ...g.blend },
    xd: g.xd ? [...g.xd] : undefined,
  };
}

const nums = (args: Operand[]): number[] => args.filter((a): a is number => typeof a === "number");
const lastNum = (args: Operand[], def = 0): number => {
  for (let i = args.length - 1; i >= 0; i--) if (typeof args[i] === "number") return args[i] as number;
  return def;
};
const firstStr = (args: Operand[]): string | undefined => {
  const s = args.find(isStr);
  return s ? s.v : undefined;
};

export function blendFromXy(args: Operand[]): BlendStyle {
  const n = nums(args);
  return {
    mode: BLEND_MODES[n[0] ?? 0] ?? "normal",
    opacity: n[1] ?? 1,
    isolated: (n[2] ?? 0) === 1,
    knockout: n[3] ?? 0,
    alphaIsShape: (n[4] ?? 0) === 1,
  };
}

/** Applies a graphics-state operator. Returns false when `s` is not a state operator. */
export function applyStateOp(g: GState, s: Statement): boolean {
  const a = s.args;
  switch (s.op) {
    case "g": case "k": case "x": case "Xa": case "Xx": {
      const c = colorFromOperator(s.op, a);
      if (c) g.fill = { type: "color", color: c };
      return true;
    }
    case "G": case "K": case "X": case "XA": case "XX": {
      const c = colorFromOperator(s.op, a);
      if (c) g.stroke = { type: "color", color: c };
      return true;
    }
    case "p":
      g.fill = { type: "pattern", name: decodeMaybeUtf8(firstStr(a) ?? ""), raw: a };
      return true;
    case "P":
      g.stroke = { type: "pattern", name: decodeMaybeUtf8(firstStr(a) ?? ""), raw: a };
      return true;
    case "w": g.strokeStyle.width = lastNum(a, 1); return true;
    case "J": g.strokeStyle.cap = (["butt", "round", "square"] as const)[lastNum(a)] ?? "butt"; return true;
    case "j": g.strokeStyle.join = (["miter", "round", "bevel"] as const)[lastNum(a)] ?? "miter"; return true;
    case "M": g.strokeStyle.miterLimit = lastNum(a, 10); return true;
    case "d": {
      const arr = a.find(isArr);
      g.strokeStyle.dash = arr ? nums(arr.v) : [];
      g.strokeStyle.dashOffset = lastNum(a, 0);
      return true;
    }
    case "XR": g.fillRule = lastNum(a) === 1 ? "evenodd" : "nonzero"; return true;
    case "O": g.fillOverprint = lastNum(a) === 1; return true;
    case "R": g.strokeOverprint = lastNum(a) === 1; return true;
    case "Xy": g.blend = blendFromXy(a); return true;
    case "Xd": {
      const n = nums(a);
      g.xd = [n[0] ?? 0, n[1] ?? 0];
      return true;
    }
  }
  return false;
}

export function styleFromGState(g: GState): PathStyle {
  const c = cloneGState(g);
  return {
    fill: c.fill,
    stroke: c.stroke,
    strokeStyle: c.strokeStyle,
    fillRule: c.fillRule,
    fillOverprint: c.fillOverprint,
    strokeOverprint: c.strokeOverprint,
    blend: c.blend,
    xd: c.xd,
  };
}

// ----------------------------------------------------------------------------- art reader

interface Frame {
  kind: "root" | "layer" | "group" | "compound" | "source";
  art?: LayerArt | GroupArt | CompoundPathArt;
  children: Art[];
  /** Art whose hidden source this frame collects. */
  target?: Art;
  /** Last completed child (receives trailers and dictionaries). */
  last?: Art;
  hidden: boolean;
}

interface PendingPath {
  first: number;
  segments: PathSegment[];
  closed: boolean;
  clip: boolean;
  hidden: boolean;
}

interface PendingGradient {
  first: number;
  name: string;
  origin: [number, number];
  angle: number;
  length: number;
  bgMatrix: Matrix;
  xm?: Matrix;
  bm?: Matrix;
  highlight?: [number, number, number, number];
  path?: PathArt;
}

interface PendingRaster {
  first: number;
  hidden: boolean;
  file: string;
  linked: boolean;
  colorSpace: string;
  matrix?: Matrix;
  xi?: Statement;
  done: boolean;
}

/** Per-art bookkeeping that is not part of the public model. */
export interface ParseSideInfo {
  /** Graphics state in effect right before the art's first statement. */
  stateBefore: WeakMap<Art, GState>;
}

let nextId = 1;

class ArtReader {
  readonly st: Statement[];
  readonly src: Uint8Array;
  readonly warnings: string[];
  readonly side: ParseSideInfo;
  g: GState = defaultGState();

  constructor(st: Statement[], src: Uint8Array, warnings: string[], side: ParseSideInfo) {
    this.st = st;
    this.src = src;
    this.warnings = warnings;
    this.side = side;
  }

  read(from: number, to: number): Art[] {
    const st = this.st;
    const root: Frame = { kind: "root", children: [], hidden: false };
    const stack: Frame[] = [root];
    const top = (): Frame => stack[stack.length - 1];

    let boundary = from; // first statement not yet owned by an art
    let stateAtBoundary = cloneGState(this.g);
    let attrs: { locked: boolean; hidden: boolean; extra: Statement[]; reversed?: boolean } = { locked: false, hidden: false, extra: [] };
    let path: PendingPath | null = null;
    let compoundD: boolean | undefined;
    let grad: PendingGradient | null = null;
    let raster: PendingRaster | null = null;

    const resetAttrs = (): void => {
      attrs = { locked: false, hidden: false, extra: [] };
    };

    const base = (first: number, last: number, hidden: boolean): ArtBase => ({
      id: nextId++,
      locked: attrs.locked,
      hidden: attrs.hidden,
      illustratorOnly: hidden,
      extra: attrs.extra,
      span: { first, last },
    });

    /** Opens a source collector when hidden art follows visible art. */
    const maybeOpenSource = (hidden: boolean): void => {
      const f = top();
      if (!hidden || f.hidden || f.kind === "source") return;
      const target = f.last;
      if (!target || target.illustratorOnly) return;
      stack.push({ kind: "source", children: [], target, hidden: true });
    };

    const closeSource = (styleName: string | undefined, at: number): void => {
      const f = stack.pop()!;
      const target = f.target!;
      target.source = f.children;
      if (styleName !== undefined) target.sourceStyle = styleName;
      if (target.span) target.span.last = at;
      top().last = target;
    };

    const finish = (art: Art, first: number, last: number): void => {
      this.side.stateBefore.set(art, stateAtBoundary);
      art.span = { first, last };
      const f = top();
      f.children.push(art);
      f.last = art;
      boundary = last + 1;
      stateAtBoundary = cloneGState(this.g);
      resetAttrs();
    };

    /** Extends the last art at this level so trailing statements stay inside its span. */
    const extendLast = (at: number): void => {
      const last = top().last;
      if (!last?.span) return;
      last.span.last = at;
      boundary = at + 1;
      stateAtBoundary = cloneGState(this.g);
    };

    for (let i = from; i < to; i++) {
      const s = st[i];
      const op = s.op;

      // --- rasters -------------------------------------------------------------------------
      if (raster && !raster.done) {
        switch (op) {
          case "XG":
            raster.file = decodeMaybeUtf8(firstStr(s.args) ?? "");
            raster.linked = lastNum(s.args) === 1;
            continue;
          case "XN": {
            const n = s.args.find((a) => isName(a));
            if (n && isName(n)) raster.colorSpace = n.v;
            continue;
          }
          case "Xh": {
            const m = s.args.find(isArr);
            if (m) raster.matrix = nums(m.v) as Matrix;
            continue;
          }
          case "XI":
            raster.xi = s;
            continue;
          case "%":
            if (s.text?.startsWith("AI5_EndRaster")) raster.done = true;
            continue;
          default:
            continue; // XH, Xr, versioned content markers...
        }
      }

      // --- comments ------------------------------------------------------------------------
      if (op === "%") {
        const t = s.text ?? "";
        if (t.startsWith("AI5_BeginRaster")) {
          if (path) this.warnings.push(`Raster inside an open path at statement ${i}`);
          maybeOpenSource(s.hidden);
          raster = { first: Math.min(boundary, i), hidden: s.hidden, file: "", linked: false, colorSpace: "DeviceRGB", done: false };
        }
        continue;
      }
      if (op === "") continue;

      // --- path construction ---------------------------------------------------------------
      if (op === "m" || op === "l" || op === "L" || op === "c" || op === "C" || op === "v" || op === "V" || op === "y" || op === "Y") {
        const n = nums(s.args);
        if (!path) {
          if (top().kind !== "compound") maybeOpenSource(s.hidden);
          path = { first: Math.min(boundary, i), segments: [], closed: false, clip: false, hidden: s.hidden };
        }
        const prev = path.segments[path.segments.length - 1];
        const smooth = op === "l" || op === "c" || op === "v" || op === "y";
        if (op === "m") path.segments.push({ kind: "move", x: n[0], y: n[1], smooth: false, op });
        else if (op === "l" || op === "L") path.segments.push({ kind: "line", x: n[0], y: n[1], smooth, op });
        else if (op === "c" || op === "C") path.segments.push({ kind: "curve", x1: n[0], y1: n[1], x2: n[2], y2: n[3], x: n[4], y: n[5], smooth, op });
        else if (op === "v" || op === "V") path.segments.push({ kind: "curve", x1: prev?.x ?? n[0], y1: prev?.y ?? n[1], x2: n[0], y2: n[1], x: n[2], y: n[3], smooth, op });
        else path.segments.push({ kind: "curve", x1: n[0], y1: n[1], x2: n[2], y2: n[3], x: n[2], y: n[3], smooth, op });
        continue;
      }
      if (op === "h" || op === "H") {
        if (path) path.closed = true;
        continue;
      }
      if (op === "W") {
        if (path) path.clip = true;
        continue;
      }
      if (op === "f" || op === "F" || op === "s" || op === "S" || op === "b" || op === "B" || op === "n" || op === "N") {
        if (!path) {
          if (raster?.done) {
            // "N" closing a raster object.
            const r = raster;
            raster = null;
            const xi = r.xi;
            const xn = xi ? nums(xi.args) : [];
            const art: RasterArt = {
              ...base(r.first, i, r.hidden),
              type: "raster",
              matrix: (r.matrix ?? ((xi?.args.find(isArr) as { v: Operand[] } | undefined)?.v.filter((x): x is number => typeof x === "number") as Matrix) ?? [1, 0, 0, 1, 0, 0]) as Matrix,
              width: xn[10] ?? xn[4] ?? 0,
              height: xn[11] ?? xn[5] ?? 0,
              bitsPerComponent: xn[12] ?? 8,
              channels: xn[13] ?? 3,
              alphaChannels: xn[14] ?? 0,
              colorSpace: r.colorSpace,
              file: r.file,
              linked: r.linked,
              dataRange: xi?.data,
              xi: xi?.args ?? [],
            };
            // XI numbers: [matrix] llx lly urx ury w h bits channels alpha ... (matrix numbers come first in nums()).
            const after = xi ? xi.args.slice(xi.args.findIndex(isArr) + 1).filter((x): x is number => typeof x === "number") : [];
            if (after.length >= 9) {
              art.width = after[4];
              art.height = after[5];
              art.bitsPerComponent = after[6];
              art.channels = after[7];
              art.alphaChannels = after[8];
            }
            finish(art, r.first, i);
            continue;
          }
          attrs.extra.push(s);
          continue;
        }
        const lower = op === "f" || op === "s" || op === "b" || op === "n";
        const p = path;
        path = null;
        const style = styleFromGState(this.g);
        const fills = op === "f" || op === "F" || op === "b" || op === "B";
        const strokes = op === "s" || op === "S" || op === "b" || op === "B";
        if (!fills) style.fill = null;
        if (!strokes) style.stroke = null;
        const art: PathArt = {
          ...base(p.first, i, p.hidden || s.hidden),
          type: "path",
          segments: p.segments,
          closed: p.closed || lower,
          paintOp: op,
          clip: p.clip,
          style,
        };
        if (top().kind === "compound" && compoundD !== undefined) art.reversed = compoundD;
        if (attrs.reversed !== undefined) art.reversed = attrs.reversed;
        if (grad) {
          if (fills) style.fill = this.gradientPaint(grad);
          grad.path = art;
        }
        finish(art, p.first, i);
        continue;
      }

      // --- containers ----------------------------------------------------------------------
      if (op === "u" || op === "q" || op === "*u") {
        maybeOpenSource(s.hidden);
        const first = Math.min(boundary, i);
        if (op === "*u") {
          const art: CompoundPathArt = { ...base(first, i, s.hidden), type: "compound", children: [] };
          this.side.stateBefore.set(art, stateAtBoundary);
          stack.push({ kind: "compound", art, children: art.children, hidden: s.hidden || top().hidden });
          compoundD = attrs.reversed;
        } else {
          const art: GroupArt = { ...base(first, i, s.hidden), type: "group", clipGroup: op === "q", children: [] };
          this.side.stateBefore.set(art, stateAtBoundary);
          stack.push({ kind: "group", art, children: art.children, hidden: s.hidden || top().hidden });
        }
        boundary = i + 1;
        stateAtBoundary = cloneGState(this.g);
        resetAttrs();
        continue;
      }
      if (op === "U" || op === "Q" || op === "*U") {
        while (top().kind === "source") closeSource(undefined, i - 1);
        const f = top();
        if (f.kind !== "group" && f.kind !== "compound") {
          this.warnings.push(`Unbalanced ${op} at statement ${i}`);
          continue;
        }
        stack.pop();
        const art = f.art as GroupArt | CompoundPathArt;
        if (attrs.extra.length) art.extra.push(...attrs.extra);
        const first = art.span!.first;
        const parent = top();
        parent.children.push(art);
        parent.last = art;
        art.span = { first, last: i };
        boundary = i + 1;
        stateAtBoundary = cloneGState(this.g);
        resetAttrs();
        if (op === "*U") compoundD = undefined;
        continue;
      }

      // --- layers --------------------------------------------------------------------------
      if (op === "Lb") {
        const n = nums(s.args);
        const art: LayerArt = {
          ...base(Math.min(boundary, i), i, s.hidden),
          type: "layer",
          layerName: "",
          visible: n[0] !== 0,
          preview: n[1] !== 0,
          locked: n[2] === 0,
          printable: n[3] !== 0,
          dimmed: n[4] === 1,
          color: n.length >= 11 ? [n[8], n[9], n[10]] : [79, 128, 255],
          lb: s.args,
          children: [],
        };
        this.side.stateBefore.set(art, stateAtBoundary);
        stack.push({ kind: "layer", art, children: art.children, hidden: s.hidden });
        boundary = i + 1;
        stateAtBoundary = cloneGState(this.g);
        resetAttrs();
        continue;
      }
      if (op === "Ln") {
        const f = stack.findLast((x) => x.kind === "layer");
        if (f?.art && f.art.type === "layer") f.art.layerName = decodeMaybeUtf8(firstStr(s.args) ?? "");
        boundary = i + 1;
        continue;
      }
      if (op === "LB") {
        while (top().kind === "source") closeSource(undefined, i - 1);
        while (top().kind === "group" || top().kind === "compound") {
          this.warnings.push(`Unclosed group before LB at statement ${i}`);
          stack.pop();
        }
        const f = top();
        if (f.kind !== "layer") {
          this.warnings.push(`Unbalanced LB at statement ${i}`);
          continue;
        }
        stack.pop();
        const art = f.art as LayerArt;
        // The closing "%AI5_EndLayer--" comment belongs to the layer.
        let last = i;
        if (st[i + 1]?.op === "%" && st[i + 1].text?.startsWith("AI5_EndLayer")) last = ++i;
        art.span = { first: art.span!.first, last };
        top().children.push(art);
        top().last = art;
        boundary = i + 1;
        stateAtBoundary = cloneGState(this.g);
        resetAttrs();
        continue;
      }

      // --- dictionaries and dictionary-encoded objects -------------------------------------
      if (op === ":") {
        const { roots, next } = parseDictBlock(st, i, to);
        const node = roots[0];
        const last = next - 1;
        if (node?.type === "AI11Text") {
          maybeOpenSource(s.hidden);
          const art: TextArt = {
            ...base(Math.min(boundary, i), last, s.hidden),
            type: "text",
            storyIndex: Number(getValue(node, "StoryIndex") ?? 0),
            undoFree: Number(getValue(node, "FreeUndo") ?? 0) === 1,
            frameIndex: Number(getValue(node, "FrameIndex") ?? 0),
            textObject: node,
            style: styleFromGState(this.g),
          };
          finish(art, Math.min(boundary, i), last);
        } else if (node?.type === "ArtDictionary") {
          const f = top();
          const target = f.last ?? (f.art as Art | undefined);
          if (target) {
            target.dictionary = node;
            const uid = findEntry(node, "AI10_ArtUID");
            if (uid?.node?.close.length && isStr(uid.node.close[0])) target.name = decodeMaybeUtf8(uid.node.close[0].v);
          }
          if (f.last) extendLast(last);
          else boundary = next;
        } else if (node) {
          attrs.extra.push(...st.slice(i, next));
        }
        i = last;
        continue;
      }

      // --- trailers ------------------------------------------------------------------------
      if (op === "XW") {
        const code = lastNum(s.args.filter((a) => typeof a === "number"), 0);
        const name = decodeMaybeUtf8(firstStr(s.args) ?? "");
        if (top().kind === "source" && !s.hidden) {
          closeSource(name, i);
          boundary = i + 1;
          stateAtBoundary = cloneGState(this.g);
          resetAttrs();
          continue;
        }
        const f = top();
        const target = f.last;
        if (target) {
          target.trailer = { code, styleName: name, attrs: st.slice(boundary, i).filter((x) => x.op !== "%" && x.op !== "") };
          // Attribute statements between the object and its trailer describe the object (blend...).
          for (let k = i - 1; k >= boundary; k--) {
            if (st[k].op === "Xy") {
              target.blend = blendFromXy(st[k].args);
              break;
            }
          }
          if (attrs.extra.length) target.extra.push(...attrs.extra);
          extendLast(i);
          resetAttrs();
        } else {
          attrs.extra.push(s);
        }
        continue;
      }

      // --- gradients -----------------------------------------------------------------------
      if (op === "Bb") {
        grad = { first: i, name: "", origin: [0, 0], angle: 0, length: 1, bgMatrix: [1, 0, 0, 1, 0, 0] };
        continue;
      }
      if (grad && (op === "Bg" || op === "Xm" || op === "Bm" || op === "Bc" || op === "Bh")) {
        const n = nums(s.args);
        if (op === "Bg") {
          grad.name = decodeMaybeUtf8(firstStr(s.args) ?? "");
          const after = s.args.slice(s.args.findIndex(isStr) + 1).filter((x): x is number => typeof x === "number");
          grad.origin = [after[0] ?? 0, after[1] ?? 0];
          grad.angle = after[2] ?? 0;
          grad.length = after[3] ?? 1;
          if (after.length >= 10) grad.bgMatrix = after.slice(4, 10) as Matrix;
        } else if (op === "Xm") grad.xm = n.slice(0, 6) as Matrix;
        else if (op === "Bm") grad.bm ??= n.slice(0, 6) as Matrix;
        else if (op === "Bh") grad.highlight = [n[0], n[1], n[2], n[3]];
        continue;
      }
      if (op === "BB") {
        if (grad?.path) {
          const p = grad.path;
          const flag = lastNum(s.args);
          if (p.style.fill?.type === "gradient") p.style.fill.flag = flag;
          if (flag === 1 || flag === 2) p.style.stroke = this.gradientPaint(grad, flag);
          if (p.span) p.span.first = Math.min(p.span.first, grad.first);
          p.span!.last = i;
          boundary = i + 1;
        }
        grad = null;
        continue;
      }

      // --- meshes --------------------------------------------------------------------------
      if (op === "X!" && isName(s.args[s.args.length - 1], "Mesh")) {
        maybeOpenSource(s.hidden);
        const first = Math.min(boundary, i);
        let j = i + 1;
        while (j < to && !(st[j].op === "X!" && isName(st[j].args[st[j].args.length - 1], "End"))) j++;
        const art: MeshArt = { ...base(first, j, s.hidden), type: "mesh", ...parseMesh(st, i, j) };
        finish(art, first, j);
        i = j;
        continue;
      }

      // --- graphics state & attributes -----------------------------------------------------
      if (applyStateOp(this.g, s)) continue;
      switch (op) {
        case "A":
          attrs.locked = lastNum(s.args) === 1;
          continue;
        case "Xw":
          attrs.hidden = lastNum(s.args) === 1;
          continue;
        case "D":
          attrs.reversed = lastNum(s.args) === 1;
          if (top().kind === "compound") compoundD = attrs.reversed;
          continue;
        default:
          attrs.extra.push(s);
      }
    }
    while (stack.length > 1) {
      const f = stack.pop()!;
      if (f.kind === "source") {
        f.target!.source = f.children;
        continue;
      }
      this.warnings.push(`Unclosed ${f.kind} at end of section`);
      if (f.art) top().children.push(f.art);
    }
    return root.children;
  }

  gradientPaint(grad: PendingGradient, flag = 0): GradientPaint {
    return {
      type: "gradient",
      name: grad.name,
      origin: grad.origin,
      angle: grad.angle,
      length: grad.length,
      bgMatrix: grad.bgMatrix,
      matrix: grad.xm ?? grad.bm ?? grad.bgMatrix,
      unitVector: grad.xm !== undefined,
      highlight: grad.highlight,
      flag,
    };
  }
}

function parseMesh(st: Statement[], from: number, to: number): Omit<MeshArt, keyof ArtBase | "type"> {
  let rows = 0, cols = 0, colorSpace = "DeviceRGB";
  const patches: MeshArt["patches"] = [];
  let cur: MeshArt["patches"][number] | null = null;
  for (let i = from + 1; i < to; i++) {
    const s = st[i];
    if (s.op !== "X#") continue;
    const key = s.args[s.args.length - 1];
    if (!isName(key)) continue;
    const val = s.args[0];
    switch (key.v) {
      case "Size":
        if (isArr(val)) [rows, cols] = nums(val.v);
        break;
      case "CS":
        if (isName(val)) colorSpace = val.v;
        break;
      case "P":
        if (isArr(val)) {
          const [r, c] = nums(val.v);
          cur = { row: r, col: c, nodes: [] };
          patches.push(cur);
        }
        break;
      case "N":
        if (cur && isArr(val)) {
          const n = nums(val.v);
          // color components, then x y, then two handles each followed by a weight.
          const nc = n.length - 8;
          cur.nodes.push({
            color: n.slice(0, nc),
            x: n[nc],
            y: n[nc + 1],
            hNext: [n[nc + 2], n[nc + 3]],
            hPrev: [n[nc + 5], n[nc + 6]],
          });
        }
        break;
    }
  }
  return { rows, cols, colorSpace, patches };
}

// ----------------------------------------------------------------------------- setup sections

function parseGradient(st: Statement[], from: number, to: number): GradientDef | null {
  let def: GradientDef | null = null;
  for (let i = from; i < to; i++) {
    const s = st[i];
    if (s.op === "Bd") {
      const n = nums(s.args);
      def = { name: decodeMaybeUtf8(firstStr(s.args) ?? ""), type: n[0] === 1 ? "radial" : "linear", stops: [] };
    } else if (s.op === "Bs" && def) {
      // c m y k r g b colorStyle opacity ? midpoint location   (7-component RGB form, Illustrator 2026)
      // gray colorStyle(0) ... / c m y k colorStyle(1) ... for other color styles.
      const n = nums(s.args);
      const loc = n[n.length - 1];
      const mid = n[n.length - 2];
      let color: Color;
      let opacity = 1;
      if (n.length >= 12) {
        color = { kind: "rgb", r: n[4], g: n[5], b: n[6], cmyk: [n[0], n[1], n[2], n[3]] };
        opacity = n[8];
      } else if (n.length >= 8) {
        color = { kind: "cmyk", c: n[0], m: n[1], y: n[2], k: n[3] };
        if (n.length >= 9) opacity = n[5];
      } else {
        color = { kind: "gray", gray: n[0] };
        if (n.length >= 5) opacity = n[2];
      }
      def.stops.push({ offset: loc / 100, midpoint: mid / 100, color, opacity, raw: s.args });
    }
  }
  if (def) def.stops.sort((a, b) => a.offset - b.offset);
  return def;
}

function parseHeader(st: Statement[], end: number): AiHeader {
  const header: AiHeader = { comments: [], documentFonts: [] };
  let lastKey = "";
  for (let i = 0; i < end; i++) {
    const s = st[i];
    if (s.op !== "%") continue;
    const t = s.text ?? "";
    if (t.startsWith("%EndComments")) break;
    const m = /^(%?[A-Za-z0-9_+]+):?\s?(.*)$/.exec(t);
    if (!m) continue;
    let key = m[1];
    const value = m[2];
    if (key === "%+") key = lastKey;
    else lastKey = key;
    header.comments.push({ key, value });
    if (key === "%Creator") header.creator = value;
    if (key === "%AI8_CreatorVersion") header.creatorVersion = value;
    if (key === "AI5_FileFormat") header.fileFormat = value;
    if (key === "%HiResBoundingBox" || (key === "%BoundingBox" && !header.boundingBox)) {
      const b = value.trim().split(/\s+/).map(Number);
      if (b.length === 4 && b.every(Number.isFinite)) header.boundingBox = b as [number, number, number, number];
    }
    if (key === "AI5_RulerUnits") header.rulerUnits = Number(value);
    if (key === "%DocumentFonts") header.documentFonts.push(value.trim());
  }
  return header;
}

function readArtboards(doc: DictNode | undefined, header: AiHeader): Artboard[] {
  const list = findEntryDeep(doc, "ArtboardArray")?.node;
  const out: Artboard[] = [];
  if (list) {
    for (const e of list.entries) {
      const ab = e.node;
      if (!ab) continue;
      const p1 = entryValue(findEntry(ab, "PositionPoint1")) as [number, number] | undefined;
      const p2 = entryValue(findEntry(ab, "PositionPoint2")) as [number, number] | undefined;
      if (!p1 || !p2) continue;
      out.push({
        name: String(getValue(ab, "Name") ?? `Artboard ${out.length + 1}`),
        left: Math.min(p1[0], p2[0]),
        right: Math.max(p1[0], p2[0]),
        top: Math.max(p1[1], p2[1]),
        bottom: Math.min(p1[1], p2[1]),
        uuid: getValue(ab, "ArtboardUUID") as string | undefined,
        rulerOrigin: entryValue(findEntry(ab, "RulerOrigin")) as [number, number] | undefined,
      });
    }
  }
  if (!out.length) {
    const crop = header.comments.find((c) => c.key === "AI3_Cropmarks")?.value.split(/\s+/).map(Number);
    const bb = crop && crop.length === 4 ? crop : header.boundingBox;
    if (bb) out.push({ name: "Artboard 1", left: bb[0], bottom: bb[1], right: bb[2], top: bb[3] });
  }
  return out;
}

export interface ParseOptions {
  /** Skip parsing the text document (faster when text is not needed). */
  skipText?: boolean;
}

/** Parses a native Illustrator stream (already decompressed). */
export function parseAiStream(src: Uint8Array, options: ParseOptions = {}): AiDocument & { side: ParseSideInfo } {
  const st = lex(src);
  const warnings: string[] = [];
  const side: ParseSideInfo = { stateBefore: new WeakMap() };
  const reader = new ArtReader(st, src, warnings, side);

  const endComments = st.findIndex((s) => s.op === "%" && s.text?.startsWith("%EndComments"));
  const header = parseHeader(st, endComments < 0 ? st.length : endComments);

  const doc: AiDocument & { side: ParseSideInfo } = {
    header,
    artboards: [],
    layers: [],
    swatches: [],
    gradients: new Map(),
    patterns: new Map(),
    symbols: new Map(),
    artStyles: new Map(),
    source: src,
    statements: st,
    bodyRange: [st.length, st.length],
    sections: {},
    warnings,
    side,
  };

  const findEnd = (from: number, prefix: string): number => {
    for (let j = from; j < st.length; j++) if (st[j].op === "%" && st[j].text?.startsWith(prefix)) return j;
    return st.length;
  };

  let pendingColor: Color | null = null;
  let inPalette = false;
  let textRuler: [number, number] = [0, 0];
  let textBytes: Uint8Array | undefined;
  let undoFreeBytes: Uint8Array | undefined;

  for (let i = 0; i < st.length; i++) {
    const s = st[i];
    if (s.op === "%") {
      const t = s.text ?? "";
      if (t.startsWith("AI5_BeginGradient")) {
        const end = findEnd(i, "AI5_EndGradient");
        const g = parseGradient(st, i, end);
        if (g) doc.gradients.set(g.name, g);
        i = end;
      } else if (t.startsWith("AI3_BeginPattern")) {
        const end = findEnd(i, "AI3_EndPattern");
        const name = decodeMaybeUtf8(/\((.*)\)/.exec(t)?.[1] ?? firstStr(st[i + 1]?.args ?? []) ?? "");
        const saved = reader.g;
        reader.g = defaultGState();
        doc.patterns.set(name, { name, art: reader.read(i + 1, end), span: { first: i, last: end } });
        reader.g = saved;
        i = end;
      } else if (t.startsWith("AI14_BeginSymbol")) {
        const end = findEnd(i, "AI10_EndSymbol");
        const name = decodeMaybeUtf8(firstStr(st[i + 1]?.args ?? []) ?? "");
        const saved = reader.g;
        reader.g = defaultGState();
        doc.symbols.set(name, { name, art: reader.read(i + 1, end) });
        reader.g = saved;
        i = end;
      } else if (t.startsWith("AI9_BeginArtStyles")) {
        const end = findEnd(i, "AI9_EndArtStyles");
        for (let j = i + 1; j < end; j++) {
          if (st[j].op !== ":") continue;
          const { roots, next } = parseDictBlock(st, j, end);
          for (const r of roots) {
            if (r.type !== "KnownStyle") continue;
            const name = decodeMaybeUtf8(String(getValue(r, "Name") ?? ""));
            const style: ArtStyle = { name, node: r };
            const def = getNode(r, "Def");
            if (def?.type === "SimpleStyle") {
              const g = defaultGState();
              for (const o of def.ops) applyStateOp(g, o);
              style.simple = styleFromGState(g);
            }
            doc.artStyles.set(name, style);
          }
          j = next - 1;
        }
        i = end;
      } else if (t.startsWith("AI5_NumLayers")) {
        doc.sections.numLayersComment = i;
      } else if (t.startsWith("AI5_BeginPalette")) {
        inPalette = true;
      } else if (t.startsWith("AI5_EndPalette")) {
        inPalette = false;
      } else if (t.startsWith("AI9_BeginDocumentData")) {
        const end = findEnd(i, "AI9_EndDocumentData");
        const j = st.findIndex((x, k) => k > i && k < end && x.op === ":");
        if (j > 0) doc.documentData = parseDictBlock(st, j, end).roots[0];
        i = end;
      } else if (t.startsWith("AI11_BeginTextDocument")) {
        const end = findEnd(i, "AI11_EndTextDocument");
        doc.sections.textDocument = [i, end];
        for (let j = i + 1; j < end; j++) {
          if (st[j].op !== ":") continue;
          const { roots, next } = parseDictBlock(st, j, end);
          const r = roots[0];
          if (r?.type === "AI11UndoFreeTextDocument") undoFreeBytes = r.binary;
          if (r?.type === "AI11TextDocument") {
            textBytes = r.binary;
            const ro = findEntry(r, "RulerOrigin");
            if (ro) {
              const v = ro.values.filter((x): x is number => typeof x === "number");
              textRuler = [v[0] ?? 0, v[1] ?? 0];
            }
          }
          j = next - 1;
        }
        i = end;
      } else if (t.startsWith("AI5_BeginLayer")) {
        // The art section runs until the page trailer.
        let end = st.findIndex((x, k) => k > i && x.op === "%" && (x.text?.startsWith("%PageTrailer") || x.text?.startsWith("%Trailer")));
        if (end < 0) end = st.length;
        doc.bodyRange = [i, end];
        reader.g = defaultGState();
        for (const a of reader.read(i, end)) {
          if (a.type === "layer") doc.layers.push(a);
          else warnings.push(`Top-level ${a.type} outside a layer`);
        }
        const lastLayer = doc.layers[doc.layers.length - 1];
        doc.sections.bodyTail = lastLayer?.span ? lastLayer.span.last + 1 : i;
        i = end;
      }
      continue;
    }
    if (inPalette) {
      const c = colorFromOperator(s.op, s.args);
      if (c) pendingColor = c;
      if (s.op === "Xz" && s.args.some(isStr)) pendingColor = { kind: "registration", name: decodeMaybeUtf8(firstStr(s.args)!) };
      if (s.op === "Pc" && pendingColor) {
        const swatch: Swatch = { name: decodeMaybeUtf8(firstStr(s.args) ?? ""), color: pendingColor };
        doc.swatches.push(swatch);
      }
    }
  }

  doc.artboards = readArtboards(doc.documentData, header);
  if (!options.skipText) {
    for (const [bytes, key] of [[textBytes, "text"], [undoFreeBytes, "undoFreeText"]] as const) {
      if (!bytes?.length) continue;
      try {
        doc[key] = readTextDocument(parseTxt2(bytes), textRuler);
      } catch (e) {
        warnings.push(`Text document (${key}) could not be parsed: ${(e as Error).message}`);
      }
    }
  }
  return doc;
}

export function resetIds(): void {
  nextId = 1;
}

export type { UnknownArt };
