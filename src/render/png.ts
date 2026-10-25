// Minimal PNG encoder (RGBA 8-bit) and raster sample extraction.

import { zlibSync } from "fflate";
import type { RasterArt } from "../model/types.ts";
import { cmykToRgb } from "../model/color.ts";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array, start = 0, end = data.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const idat = zlibSync(raw, { level: 6 });
  const chunks: [string, Uint8Array][] = [];
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  chunks.push(["IHDR", ihdr], ["IDAT", idat], ["IEND", new Uint8Array(0)]);
  let total = 8;
  for (const [, d] of chunks) total += 12 + d.length;
  const out = new Uint8Array(total);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let p = 8;
  const odv = new DataView(out.buffer);
  for (const [type, d] of chunks) {
    odv.setUint32(p, d.length);
    for (let i = 0; i < 4; i++) out[p + 4 + i] = type.charCodeAt(i);
    out.set(d, p + 8);
    odv.setUint32(p + 8 + d.length, crc32(out, p + 4, p + 8 + d.length));
    p += 12 + d.length;
  }
  return out;
}

/**
 * Decodes the samples of a raster into RGBA (8-bit). Illustrator stores the color samples
 * interleaved (w*h*channels) followed by each alpha plane (w*h). `maxSize` downsamples so the
 * longest side does not exceed it.
 */
export function rasterToRgba(art: RasterArt, source: Uint8Array, maxSize = Infinity): { rgba: Uint8Array; width: number; height: number } | null {
  if (!art.dataRange || art.bitsPerComponent !== 8) return null;
  const [start, end] = art.dataRange;
  const w = art.width, h = art.height, ch = art.channels;
  const colorBytes = w * h * ch;
  if (end - start < colorBytes) return null;
  const hasAlpha = art.alphaChannels > 0 && end - start >= colorBytes + w * h;
  const scale = Math.min(1, maxSize / Math.max(w, h));
  const ow = Math.max(1, Math.round(w * scale));
  const oh = Math.max(1, Math.round(h * scale));
  const out = new Uint8Array(ow * oh * 4);
  for (let y = 0; y < oh; y++) {
    const sy = Math.min(h - 1, Math.floor((y + 0.5) / scale));
    for (let x = 0; x < ow; x++) {
      const sx = Math.min(w - 1, Math.floor((x + 0.5) / scale));
      const si = start + (sy * w + sx) * ch;
      const o = (y * ow + x) * 4;
      if (ch === 3) {
        out[o] = source[si];
        out[o + 1] = source[si + 1];
        out[o + 2] = source[si + 2];
      } else if (ch === 4) {
        const [r, g, b] = cmykToRgb(source[si] / 255, source[si + 1] / 255, source[si + 2] / 255, source[si + 3] / 255);
        out[o] = r * 255;
        out[o + 1] = g * 255;
        out[o + 2] = b * 255;
      } else {
        out[o] = out[o + 1] = out[o + 2] = source[si];
      }
      out[o + 3] = hasAlpha ? source[start + colorBytes + sy * w + sx] : 255;
    }
  }
  return { rgba: out, width: ow, height: oh };
}

export function bytesToBase64(bytes: Uint8Array): string {
  const B = globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } };
  if (B.Buffer) return B.Buffer.from(bytes).toString("base64");
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  return btoa(s);
}
