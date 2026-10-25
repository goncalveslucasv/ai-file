// Semantic comparison of two parsed documents (used by the round-trip tests).
import type { AiDocument, Art } from "../src/model/types.ts";

const round = (v: unknown): unknown => {
  if (typeof v === "number") return Math.round(v * 1e6) / 1e6;
  if (Array.isArray(v)) return v.map(round);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = round(x);
    return o;
  }
  return v;
};

/** A stable, comparable projection of an art subtree. */
export function artSignature(a: Art): unknown {
  const base = { type: a.type, locked: a.locked, hidden: a.hidden, io: a.illustratorOnly, name: a.name, style: a.trailer?.styleName, src: a.source?.map(artSignature), srcStyle: a.sourceStyle };
  switch (a.type) {
    case "layer":
      return { ...base, layer: a.layerName, visible: a.visible, children: a.children.map(artSignature) };
    case "group":
      return { ...base, clip: a.clipGroup, blend: a.blend, children: a.children.map(artSignature) };
    case "compound":
      return { ...base, children: a.children.map(artSignature) };
    case "path":
      return round({ ...base, segs: a.segments.map((s) => [s.kind, s.x, s.y, s.x1, s.y1, s.x2, s.y2]), closed: a.closed, clip: a.clip, fill: a.style.fill, stroke: a.style.stroke, ss: a.style.strokeStyle, rule: a.style.fillRule, blend: a.style.blend });
    case "raster":
      return round({ ...base, m: a.matrix, w: a.width, h: a.height, ch: a.channels, al: a.alphaChannels, file: a.file, bytes: a.dataRange ? a.dataRange[1] - a.dataRange[0] : 0 });
    case "text":
      return { ...base, story: a.storyIndex, frame: a.frameIndex, undoFree: a.undoFree };
    case "mesh":
      return round({ ...base, rows: a.rows, cols: a.cols, patches: a.patches });
    default:
      return base;
  }
}

export function docSignature(d: AiDocument): unknown {
  return {
    artboards: round(d.artboards),
    layers: d.layers.map(artSignature),
    stories: d.text?.stories.map((s) => s.text),
    swatches: d.swatches.length,
    gradients: [...d.gradients.keys()],
  };
}

/** Returns the first differing path between two JSON-like values, or null. */
export function firstDiff(a: unknown, b: unknown, path = "$"): string | null {
  if (typeof a !== typeof b) return `${path}: ${JSON.stringify(a)?.slice(0, 200)} !== ${JSON.stringify(b)?.slice(0, 200)}`;
  if (a && b && typeof a === "object") {
    const ka = Object.keys(a as object), kb = Object.keys(b as object);
    for (const k of new Set([...ka, ...kb])) {
      const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return a === b ? null : `${path}: ${JSON.stringify(a)?.slice(0, 200)} !== ${JSON.stringify(b)?.slice(0, 200)}`;
}
