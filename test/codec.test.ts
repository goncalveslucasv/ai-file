import assert from "node:assert/strict";
import { test } from "node:test";
import zlib from "node:zlib";
import { deflate, inflate, pngFromRgba, rasterPlanes, rasterRgba, zstdCompress, zstdDecompress } from "../src/wasm/codec.ts";

const sample = (n: number): Uint8Array => {
  const b = new Uint8Array(n);
  let x = 1;
  for (let i = 0; i < n; i++) b[i] = i % 7 === 0 ? (x = (x * 1103515245 + 12345) >>> 0) >>> 24 : b[i - 1] ?? 0;
  return b;
};

test("zstd round trip, interoperable with node:zlib, chunked input", () => {
  const data = sample(3_000_000);
  const z = zstdCompress(data, 3);
  assert.deepEqual(new Uint8Array(zlib.zstdDecompressSync(z)), data);
  const chunks = [];
  for (let i = 0; i < z.length; i += 1000) chunks.push(z.subarray(i, i + 1000));
  assert.deepEqual(zstdDecompress(chunks), data);
  // Concatenated frames decode as one stream.
  const two = zstdDecompress([zlib.zstdCompressSync(data.subarray(0, 10)), zlib.zstdCompressSync(data.subarray(10, 20))]);
  assert.deepEqual(two, data.subarray(0, 20));
});

test("deflate / inflate round trip, zlib and raw framing", () => {
  const data = sample(2_500_000);
  const z = deflate(data, 6);
  assert.deepEqual(new Uint8Array(zlib.inflateSync(z)), data);
  assert.deepEqual(inflate(z), data);
  assert.deepEqual(inflate(zlib.deflateRawSync(data), "auto"), data);
  assert.deepEqual(inflate(deflate(data, 1, false), "raw"), data);
  assert.deepEqual(inflate(deflate(new Uint8Array(0))), new Uint8Array(0));
  assert.throws(() => zstdDecompress(new Uint8Array([1, 2, 3, 4, 5])), /zstd/);
});

test("raster conversion: RGB + alpha, CMYK, resampling, PNG", () => {
  // 2x1 RGB with alpha plane.
  const r = { data: new Uint8Array([10, 20, 30, 40, 50, 60, 255, 128]), width: 2, height: 1, channels: 3, hasAlpha: true };
  assert.deepEqual(rasterRgba(r), new Uint8Array([10, 20, 30, 255, 40, 50, 60, 128]));
  assert.deepEqual(rasterPlanes(r), { rgb: new Uint8Array([10, 20, 30, 40, 50, 60]), alpha: new Uint8Array([255, 128]) });
  assert.deepEqual(rasterRgba(r, 1, 1), new Uint8Array([40, 50, 60, 128]));
  const cmyk = { data: new Uint8Array([0, 255, 255, 0]), width: 1, height: 1, channels: 4, hasAlpha: false };
  assert.deepEqual(rasterRgba(cmyk), new Uint8Array([255, 0, 0, 255]));
  const png = pngFromRgba(new Uint8Array([1, 2, 3, 4]), 1, 1);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});
