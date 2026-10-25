// Editing helpers for the native model. Every mutation marks the touched objects dirty so the
// writer regenerates them (everything else is copied byte-for-byte).

import type { AiDocument, Art, Color, GroupArt, LayerArt, Matrix, PathArt, PathSegment, PathStyle } from "./model/types.ts";
import { defaultGState, styleFromGState } from "./parse/document.ts";
import { setStoryText as setTxt2StoryText, type TextDocument } from "./text/txt2.ts";

type Parent = LayerArt | GroupArt | { type: "compound"; children: Art[] };

/** Depth-first walk over every art object (layers included). Return false to skip children. */
export function walk(doc: AiDocument, fn: (art: Art, parent: Art | null, depth: number) => boolean | void, includeSources = false): void {
  const visit = (a: Art, parent: Art | null, depth: number): void => {
    if (fn(a, parent, depth) === false) return;
    if ("children" in a) for (const c of a.children) visit(c, a, depth + 1);
    if (includeSources && a.source) for (const c of a.source) visit(c, a, depth + 1);
  };
  for (const l of doc.layers) visit(l, null, 0);
}

export function findArt(doc: AiDocument, pred: (a: Art) => boolean): Art | undefined {
  let found: Art | undefined;
  walk(doc, (a) => {
    if (found) return false;
    if (pred(a)) found = a;
  });
  return found;
}

export function parentOf(doc: AiDocument, target: Art): Art | null {
  let parent: Art | null = null;
  walk(doc, (a, p) => {
    if (a === target) parent = p;
  }, true);
  return parent;
}

export function markDirty(a: Art): void {
  a.dirty = true;
}

/** Removes an art object from its parent. */
export function removeArt(doc: AiDocument, target: Art): boolean {
  const parent = parentOf(doc, target);
  if (!parent) {
    const i = doc.layers.indexOf(target as LayerArt);
    if (i >= 0) doc.layers.splice(i, 1);
    return i >= 0;
  }
  const list = "children" in parent && (parent.children as Art[]).includes(target) ? (parent.children as Art[]) : parent.source;
  if (!list) return false;
  list.splice(list.indexOf(target), 1);
  parent.dirty = true;
  return true;
}

/** Inserts `art` into `parent` (index defaults to the top of the stacking order). */
export function insertArt(parent: Parent, art: Art, index = parent.children.length): void {
  (parent.children as Art[]).splice(index, 0, art);
  (parent as Art).dirty = true;
  art.dirty = true;
}

const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const multiply = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];

/**
 * Applies an affine transform (art space) to an object and everything inside it: path points,
 * gradient matrices, raster matrices, mesh nodes and text frames. Text frames live in the text
 * document (y down), so the transform is conjugated into text space.
 */
export function transformArt(doc: AiDocument, art: Art, m: Matrix): void {
  const tp = (s: PathSegment): void => {
    [s.x, s.y] = apply(m, s.x, s.y);
    if (s.x1 !== undefined) [s.x1, s.y1] = apply(m, s.x1, s.y1!);
    if (s.x2 !== undefined) [s.x2, s.y2] = apply(m, s.x2, s.y2!);
  };
  const visit = (a: Art): void => {
    a.dirty = true;
    switch (a.type) {
      case "path":
        a.segments.forEach(tp);
        for (const p of [a.style.fill, a.style.stroke]) if (p?.type === "gradient") p.matrix = multiply(m, p.matrix);
        break;
      case "raster":
        a.matrix = multiply(m, a.matrix);
        break;
      case "mesh":
        for (const patch of a.patches) for (const node of patch.nodes) {
          [node.x, node.y] = apply(m, node.x, node.y);
          node.hNext = apply(m, ...node.hNext);
          node.hPrev = apply(m, ...node.hPrev);
        }
        // Meshes are copied verbatim by the writer; geometry edits are not persisted yet.
        break;
      case "text": {
        const td: TextDocument | undefined = a.undoFree ? doc.undoFreeText : doc.text;
        const story = td?.stories[a.storyIndex];
        const frame = story ? td!.frames[story.frameIds[a.frameIndex]] : undefined;
        if (td && frame) {
          const [rx, ry] = td.rulerOrigin;
          // art = R(t) with R = [1 0 0 -1 -rx ry]; text-space transform = R^-1 · m · R.
          const R: Matrix = [1, 0, 0, -1, -rx, ry];
          const Rinv: Matrix = [1, 0, 0, -1, rx, ry];
          frame.matrix = multiply(multiply(Rinv, multiply(m, R)), frame.matrix);
          const raw = frame.raw.get("2");
          if (raw instanceof Map) raw.set("2", [...frame.matrix]);
          doc.textDirty = true;
        }
        break;
      }
    }
    if ("children" in a) for (const c of a.children) visit(c);
    if (a.source) for (const c of a.source) visit(c);
  };
  visit(art);
}

export function translateArt(doc: AiDocument, art: Art, dx: number, dy: number): void {
  transformArt(doc, art, [1, 0, 0, 1, dx, dy]);
}

/** Sets a solid fill on a path (or every path inside a group / compound path). */
export function setFillColor(art: Art, color: Color | null): void {
  const visit = (a: Art): void => {
    if (a.type === "path") {
      a.style.fill = color ? { type: "color", color } : null;
      a.dirty = true;
    }
    if ("children" in a) for (const c of a.children) visit(c);
  };
  visit(art);
}

export function setStrokeColor(art: Art, color: Color | null, width?: number): void {
  const visit = (a: Art): void => {
    if (a.type === "path") {
      a.style.stroke = color ? { type: "color", color } : null;
      if (width !== undefined) a.style.strokeStyle.width = width;
      a.dirty = true;
    }
    if ("children" in a) for (const c of a.children) visit(c);
  };
  visit(art);
}

export function setOpacity(art: Art, opacity: number): void {
  if (art.type === "path") art.style.blend = { ...art.style.blend, opacity };
  else art.blend = { mode: "normal", isolated: false, knockout: 0, alphaIsShape: false, ...art.blend, opacity };
  art.dirty = true;
}

/** Replaces the text of the story shown by a text object. */
export function setText(doc: AiDocument, art: Art, text: string): void {
  if (art.type !== "text") throw new Error("Not a text object");
  const td = art.undoFree ? doc.undoFreeText : doc.text;
  if (!td) throw new Error("Document has no text");
  setTxt2StoryText(td, art.storyIndex, text);
  doc.textDirty = true;
}

let createdId = 1_000_000;

export function rgb(r: number, g: number, b: number): Color {
  return { kind: "rgb", r, g, b };
}

export function createPath(segments: PathSegment[], style: Partial<PathStyle> = {}, closed = true): PathArt {
  return {
    id: createdId++,
    type: "path",
    segments,
    closed,
    paintOp: "f",
    clip: false,
    style: { ...styleFromGState(defaultGState()), stroke: null, ...style },
    locked: false,
    hidden: false,
    illustratorOnly: false,
    extra: [],
    dirty: true,
  };
}

export function createRect(x: number, y: number, width: number, height: number, style: Partial<PathStyle> = {}): PathArt {
  // Art space has y up: (x, y) is the top-left corner.
  const pts: [number, number][] = [[x, y], [x + width, y], [x + width, y - height], [x, y - height]];
  return createPath(pts.map(([px, py], i) => ({ kind: i ? "line" : "move", x: px, y: py, smooth: false, op: i ? "L" : "m" })), style);
}

export function createEllipse(cx: number, cy: number, rx: number, ry: number, style: Partial<PathStyle> = {}): PathArt {
  const k = 0.5522847498;
  const segs: PathSegment[] = [
    { kind: "move", x: cx + rx, y: cy, smooth: false, op: "m" },
    { kind: "curve", x1: cx + rx, y1: cy - ry * k, x2: cx + rx * k, y2: cy - ry, x: cx, y: cy - ry, smooth: true, op: "c" },
    { kind: "curve", x1: cx - rx * k, y1: cy - ry, x2: cx - rx, y2: cy - ry * k, x: cx - rx, y: cy, smooth: true, op: "c" },
    { kind: "curve", x1: cx - rx, y1: cy + ry * k, x2: cx - rx * k, y2: cy + ry, x: cx, y: cy + ry, smooth: true, op: "c" },
    { kind: "curve", x1: cx + rx * k, y1: cy + ry, x2: cx + rx, y2: cy + ry * k, x: cx + rx, y: cy, smooth: true, op: "c" },
  ];
  return createPath(segs, style);
}

export function createGroup(children: Art[] = [], clipGroup = false): GroupArt {
  return { id: createdId++, type: "group", clipGroup, children, locked: false, hidden: false, illustratorOnly: false, extra: [], dirty: true };
}
