// PNG encoding and raster sample extraction (the pixel work runs in the wasm codecs).

import type { RasterArt } from "../model/types.ts";
import { pngFromRgba, rasterPlanes, rasterPng, rasterRgba, type RasterSamples } from "../wasm/codec.ts";

/** Encodes 8-bit RGBA pixels as a PNG. `level` 0-9 trades size for speed. */
export function encodePng(rgba: Uint8Array, width: number, height: number, level = 6): Uint8Array {
  return pngFromRgba(rgba, width, height, level);
}

/**
 * The samples of an 8-bit raster and its output size when the longest side is limited to
 * `maxSize`. Illustrator stores the color samples interleaved (w*h*channels) followed by each
 * alpha plane (w*h).
 */
function samples(art: RasterArt, source: Uint8Array, maxSize: number): { r: RasterSamples; width: number; height: number } | null {
  if (!art.dataRange || art.bitsPerComponent !== 8) return null;
  const [start, end] = art.dataRange;
  const w = art.width, h = art.height, ch = art.channels;
  const colorBytes = w * h * ch;
  if (end - start < colorBytes || ch < 1 || ch > 4) return null;
  const hasAlpha = art.alphaChannels > 0 && end - start >= colorBytes + w * h;
  const scale = Math.min(1, maxSize / Math.max(w, h));
  const r = { data: source.subarray(start, start + colorBytes + (hasAlpha ? w * h : 0)), width: w, height: h, channels: ch, hasAlpha };
  return { r, width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** Decodes the samples of a raster into RGBA (8-bit), downsampled so the longest side is at most `maxSize`. */
export function rasterToRgba(art: RasterArt, source: Uint8Array, maxSize = Infinity): { rgba: Uint8Array; width: number; height: number } | null {
  const s = samples(art, source, maxSize);
  return s && { rgba: rasterRgba(s.r, s.width, s.height), width: s.width, height: s.height };
}

/** Encodes a raster as a PNG in one pass, downsampled so the longest side is at most `maxSize`. */
export function rasterToPng(art: RasterArt, source: Uint8Array, maxSize = Infinity, level = 2): { png: Uint8Array; width: number; height: number } | null {
  const s = samples(art, source, maxSize);
  return s && { png: rasterPng(s.r, s.width, s.height, level), width: s.width, height: s.height };
}

/** Raster → RGB plane plus optional alpha plane (PDF image + soft mask). */
export function rasterToPlanes(art: RasterArt, source: Uint8Array, maxSize = Infinity): { rgb: Uint8Array; alpha?: Uint8Array; width: number; height: number } | null {
  const s = samples(art, source, maxSize);
  if (!s) return null;
  if (s.r.channels === 3 && s.width === s.r.width && s.height === s.r.height) {
    const n = s.width * s.height * 3;
    return { rgb: s.r.data.subarray(0, n), alpha: s.r.hasAlpha ? s.r.data.subarray(n) : undefined, width: s.width, height: s.height };
  }
  return { ...rasterPlanes(s.r, s.width, s.height), width: s.width, height: s.height };
}

export function bytesToBase64(bytes: Uint8Array): string {
  const B = globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } };
  if (B.Buffer) return B.Buffer.from(bytes).toString("base64");
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  return btoa(s);
}
