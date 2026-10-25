// Conservative bounding boxes in art space (control points included, strokes padded).

import type { Art } from "./types.ts";

/** [left, bottom, right, top] in art space (y up). */
export type Bounds = [number, number, number, number];

const EMPTY: Bounds = [Infinity, Infinity, -Infinity, -Infinity];

function add(b: Bounds, x: number, y: number): void {
  if (x < b[0]) b[0] = x;
  if (y < b[1]) b[1] = y;
  if (x > b[2]) b[2] = x;
  if (y > b[3]) b[3] = y;
}

/**
 * Bounds of an art object, or null when they are unknown (text, unmodelled art). Bézier control
 * points are included, so the box can be larger than the visible shape but never smaller.
 */
export function artBounds(a: Art): Bounds | null {
  const b: Bounds = [...EMPTY];
  switch (a.type) {
    case "path": {
      for (const s of a.segments) {
        add(b, s.x, s.y);
        if (s.x1 !== undefined) add(b, s.x1, s.y1!);
        if (s.x2 !== undefined) add(b, s.x2, s.y2!);
      }
      const pad = a.style.stroke ? a.style.strokeStyle.width * Math.max(2, a.style.strokeStyle.miterLimit) : 0;
      return b[0] <= b[2] ? [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad] : null;
    }
    case "raster": {
      const [ma, mb, mc, md, tx, ty] = a.matrix;
      for (const [u, v] of [[0, 0], [a.width, 0], [0, a.height], [a.width, a.height]]) add(b, tx + ma * u - mc * v, ty + mb * u - md * v);
      return b;
    }
    case "mesh":
      for (const p of a.patches) for (const n of p.nodes) {
        add(b, n.x, n.y);
        add(b, n.hNext[0], n.hNext[1]);
        add(b, n.hPrev[0], n.hPrev[1]);
      }
      return b[0] <= b[2] ? b : null;
    case "group":
    case "compound":
    case "layer": {
      for (const c of a.children) {
        const cb = artBounds(c);
        if (!cb) return null;
        add(b, cb[0], cb[1]);
        add(b, cb[2], cb[3]);
      }
      return b[0] <= b[2] ? b : null;
    }
    default:
      return null;
  }
}

export function intersects(a: Bounds, b: Bounds): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}
