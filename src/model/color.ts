// Color helpers: parsing of color operators and conversion to sRGB for rendering.

import { decodeMaybeUtf8 } from "../bytes.ts";
import { isStr, type Operand } from "../syntax/lexer.ts";
import type { Color } from "./types.ts";

const numsOf = (args: Operand[]): number[] => args.filter((a): a is number => typeof a === "number");
const strOf = (args: Operand[]): string => {
  const s = args.find(isStr);
  return s ? decodeMaybeUtf8(s.v) : "";
};

/** Builds a Color from a color operator (g G k K x X Xa XA Xx XX). Returns null if unsupported. */
export function colorFromOperator(op: string, args: Operand[]): Color | null {
  const n = numsOf(args);
  switch (op.toLowerCase()) {
    case "g":
      return { kind: "gray", gray: n[n.length - 1] ?? 0 };
    case "k":
      return { kind: "cmyk", c: n[0], m: n[1], y: n[2], k: n[3] };
    case "xa":
      // c m y k r g b — RGB color with its CMYK equivalent.
      if (n.length >= 7) return { kind: "rgb", r: n[4], g: n[5], b: n[6], cmyk: [n[0], n[1], n[2], n[3]] };
      return { kind: "rgb", r: n[n.length - 3], g: n[n.length - 2], b: n[n.length - 1] };
    case "x": {
      // c m y k (name) tint x
      const name = strOf(args);
      const base: Color = { kind: "cmyk", c: n[0], m: n[1], y: n[2], k: n[3] };
      if (name === "[Registration]") return { kind: "registration", name };
      return { kind: "named", name, tint: n[4] ?? 0, base, spot: true };
    }
    case "xx": {
      // c m y k (name) tint type Xx   or   r g b (name) tint 1 Xx
      const name = strOf(args);
      const type = n[n.length - 1];
      const tint = n[n.length - 2] ?? 0;
      const base: Color = type === 1 ? { kind: "rgb", r: n[0], g: n[1], b: n[2] } : { kind: "cmyk", c: n[0], m: n[1], y: n[2], k: n[3] };
      if (name === "[Registration]") return { kind: "registration", name };
      return { kind: "named", name, tint, base, spot: true };
    }
  }
  return null;
}

export type RGB = [number, number, number];

export function cmykToRgb(c: number, m: number, y: number, k: number): RGB {
  return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
}

/** Approximate sRGB (0..1) of a color. */
export function toRgb(color: Color): RGB {
  switch (color.kind) {
    case "gray":
      return [color.gray, color.gray, color.gray];
    case "cmyk":
      return cmykToRgb(color.c, color.m, color.y, color.k);
    case "rgb":
      return [color.r, color.g, color.b];
    case "registration":
      return [0, 0, 0];
    case "named": {
      const base = toRgb(color.base);
      // Tint 0 = full color, 1 = white (Illustrator stores 1 - tint percentage).
      const t = 1 - color.tint;
      return [1 - (1 - base[0]) * t, 1 - (1 - base[1]) * t, 1 - (1 - base[2]) * t];
    }
  }
}

export function rgbHex([r, g, b]: RGB): string {
  const h = (v: number): string => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function colorCss(color: Color): string {
  return rgbHex(toRgb(color));
}
