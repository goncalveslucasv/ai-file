// Gradient mesh tessellation shared by the SVG and PDF renderers.

import type { MeshArt, MeshPatchNode } from "../model/types.ts";

export interface MeshCell {
  /** Quad corners in art space. */
  quad: [number, number][];
  /** Interpolated color components (mesh color space) at the cell center. */
  color: number[];
}

type Pt = [number, number];

function bezier(c: Pt[], t: number): Pt {
  const u = 1 - t;
  return [
    u * u * u * c[0][0] + 3 * u * u * t * c[1][0] + 3 * u * t * t * c[2][0] + t * t * t * c[3][0],
    u * u * u * c[0][1] + 3 * u * u * t * c[1][1] + 3 * u * t * t * c[2][1] + t * t * t * c[3][1],
  ];
}

/**
 * Splits every patch into steps×steps cells. Patch corners are listed in order; the edge from
 * corner k to k+1 is the cubic (corner k, k.hNext, (k+1).hPrev, corner k+1). The surface is the
 * bilinearly-blended Coons patch of the four edges; colors are interpolated bilinearly.
 */
export function tessellateMesh(mesh: MeshArt, steps = 8): MeshCell[] {
  const cells: MeshCell[] = [];
  for (const patch of mesh.patches) {
    if (patch.nodes.length !== 4) continue;
    const [p0, p1, p2, p3] = patch.nodes;
    const edge = (A: MeshPatchNode, B: MeshPatchNode): Pt[] => [[A.x, A.y], A.hNext, B.hPrev, [B.x, B.y]];
    const e0 = edge(p0, p1), e1 = edge(p1, p2), e2 = edge(p2, p3), e3 = edge(p3, p0);
    const S = (s: number, t: number): Pt => {
      const c0 = bezier(e0, s), c1 = bezier(e2, 1 - s), d0 = bezier(e3, 1 - t), d1 = bezier(e1, t);
      const bx = (1 - s) * (1 - t) * p0.x + s * (1 - t) * p1.x + s * t * p2.x + (1 - s) * t * p3.x;
      const by = (1 - s) * (1 - t) * p0.y + s * (1 - t) * p1.y + s * t * p2.y + (1 - s) * t * p3.y;
      return [(1 - t) * c0[0] + t * c1[0] + (1 - s) * d0[0] + s * d1[0] - bx, (1 - t) * c0[1] + t * c1[1] + (1 - s) * d0[1] + s * d1[1] - by];
    };
    const ncomp = Math.max(p0.color.length, 1);
    const col = (s: number, t: number): number[] =>
      Array.from({ length: ncomp }, (_, k) => (1 - s) * (1 - t) * (p0.color[k] ?? 0) + s * (1 - t) * (p1.color[k] ?? 0) + s * t * (p2.color[k] ?? 0) + (1 - s) * t * (p3.color[k] ?? 0));
    for (let i = 0; i < steps; i++) {
      for (let j = 0; j < steps; j++) {
        const s0 = i / steps, s1 = (i + 1) / steps, t0 = j / steps, t1 = (j + 1) / steps;
        cells.push({ quad: [S(s0, t0), S(s1, t0), S(s1, t1), S(s0, t1)], color: col((s0 + s1) / 2, (t0 + t1) / 2) });
      }
    }
  }
  return cells;
}
