// Bindings for the Rust/WebAssembly codecs (wasm/src/lib.rs).
//
// The module is embedded (binary.ts) and instantiated synchronously on first use, so every API
// stays synchronous. `initWasm()` can be awaited beforehand to compile it off the main thread.
//
// Data moves in chunks: the Rust side pulls input through `js_read` and pushes output through
// `js_write`, so a 1 GB stream never has to be copied into wasm memory as a whole.

import { WASM_BASE64 } from "./binary.ts";

interface Exports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  error_ptr(): number;
  error_len(): number;
  zstd_decompress(): number;
  zstd_compress(level: number): number;
  deflate(level: number, zlibHeader: number): number;
  inflate(zlibHeader: number): number;
  raster(src: number, srcLen: number, w: number, h: number, channels: number, hasAlpha: number, outW: number, outH: number, mode: number, level: number): number;
  png_rgba(src: number, w: number, h: number, level: number): number;
}

export type Input = Uint8Array | Iterable<Uint8Array>;

/** Growable output buffer; the final result is a view, not a copy. */
class Output {
  private buf: Uint8Array;
  length = 0;
  constructor(hint: number) {
    this.buf = new Uint8Array(Math.max(1 << 16, hint));
  }
  push(src: Uint8Array): void {
    if (this.length + src.length > this.buf.length) {
      const next = new Uint8Array(Math.max(this.length + src.length, Math.min(this.buf.length * 2, this.buf.length + (1 << 30))));
      next.set(this.buf.subarray(0, this.length));
      this.buf = next;
    }
    this.buf.set(src, this.length);
    this.length += src.length;
  }
  result(): Uint8Array {
    return this.buf.subarray(0, this.length);
  }
}

interface Job {
  chunks: Iterator<Uint8Array>;
  current: Uint8Array;
  offset: number;
  consumed: number;
  onRead?: (consumed: number) => void;
  out: (bytes: Uint8Array) => void;
}

let wasm: Exports | undefined;
let job: Job | undefined;

const imports = {
  env: {
    js_read(ptr: number, len: number): number {
      const j = job!;
      while (j.offset >= j.current.length) {
        const next = j.chunks.next();
        if (next.done) return 0;
        j.current = next.value;
        j.offset = 0;
      }
      const n = Math.min(len, j.current.length - j.offset);
      new Uint8Array(wasm!.memory.buffer, ptr, n).set(j.current.subarray(j.offset, j.offset + n));
      j.offset += n;
      j.consumed += n;
      j.onRead?.(j.consumed);
      return n;
    },
    js_write(ptr: number, len: number): void {
      job!.out(new Uint8Array(wasm!.memory.buffer, ptr, len));
    },
  },
};

function decodeBase64(b64: string): Uint8Array {
  const U = Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array };
  if (U.fromBase64) return U.fromBase64(b64);
  const B = globalThis as { Buffer?: { from(s: string, enc: string): Uint8Array } };
  if (B.Buffer) return new Uint8Array(B.Buffer.from(b64, "base64"));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function instance(): Exports {
  if (!wasm) {
    const module = new WebAssembly.Module(decodeBase64(WASM_BASE64) as Uint8Array<ArrayBuffer>);
    wasm = new WebAssembly.Instance(module, imports).exports as unknown as Exports;
  }
  return wasm;
}

/** Compiles and instantiates the codecs asynchronously (optional; they load on first use otherwise). */
export async function initWasm(): Promise<void> {
  if (wasm) return;
  const { instance: inst } = await WebAssembly.instantiate(decodeBase64(WASM_BASE64) as Uint8Array<ArrayBuffer>, imports);
  wasm ??= inst.exports as unknown as Exports;
}

function check(w: Exports, code: number): void {
  if (code >= 0) return;
  const msg = new TextDecoder().decode(new Uint8Array(w.memory.buffer, w.error_ptr(), w.error_len()));
  throw new Error(msg || `wasm codec error ${code}`);
}

function run(input: Input, hint: number, call: (w: Exports) => number, onRead?: (consumed: number) => void): Uint8Array {
  const w = instance();
  if (job) throw new Error("wasm codec re-entered");
  const out = new Output(hint);
  const chunks = input instanceof Uint8Array ? [input][Symbol.iterator]() : input[Symbol.iterator]();
  job = { chunks, current: new Uint8Array(0), offset: 0, consumed: 0, onRead, out: (b) => out.push(b) };
  try {
    check(w, call(w));
  } finally {
    job = undefined;
  }
  return out.result();
}

function totalLength(input: Input): number {
  if (input instanceof Uint8Array) return input.length;
  let n = 0;
  if (Array.isArray(input)) for (const c of input as Uint8Array[]) n += c.length;
  return n;
}

export interface CodecOptions {
  /** Expected output size, to avoid regrowing the output buffer. */
  sizeHint?: number;
  /** Called as input is consumed, with the number of input bytes read so far. */
  onRead?: (consumed: number) => void;
}

/** Decompresses zstd data (one or more frames). */
export function zstdDecompress(input: Input, options: CodecOptions = {}): Uint8Array {
  return run(input, options.sizeHint ?? totalLength(input) * 3, (w) => w.zstd_decompress(), options.onRead);
}

/** Compresses into one zstd frame. Level 0 stores, any other level uses the fast strategy (≈ zstd 1). */
export function zstdCompress(input: Input, level = 1, options: CodecOptions = {}): Uint8Array {
  return run(input, options.sizeHint ?? totalLength(input) / 2, (w) => w.zstd_compress(level), options.onRead);
}

/** Deflate compression, zlib framing by default. */
export function deflate(input: Input, level = 6, zlibHeader = true, options: CodecOptions = {}): Uint8Array {
  return run(input, options.sizeHint ?? totalLength(input) / 2, (w) => w.deflate(level, zlibHeader ? 1 : 0), options.onRead);
}

/** Inflates zlib or raw deflate data ("auto" detects the zlib header). */
export function inflate(input: Input, framing: "zlib" | "raw" | "auto" = "auto", options: CodecOptions = {}): Uint8Array {
  const header = framing === "zlib" ? 1 : framing === "raw" ? 0 : -1;
  return run(input, options.sizeHint ?? totalLength(input) * 4, (w) => w.inflate(header), options.onRead);
}

/** Copies `bytes` into wasm memory for the duration of `fn`. */
function withBytes<T>(bytes: Uint8Array, fn: (w: Exports, ptr: number) => T): T {
  const w = instance();
  const ptr = w.alloc(bytes.length);
  try {
    new Uint8Array(w.memory.buffer, ptr, bytes.length).set(bytes);
    return fn(w, ptr);
  } finally {
    w.dealloc(ptr, bytes.length);
  }
}

export interface RasterSamples {
  /** Interleaved color samples followed by the alpha plane (Illustrator layout). */
  data: Uint8Array;
  width: number;
  height: number;
  channels: number;
  hasAlpha: boolean;
}

/** Raster conversion modes, see `raster` in wasm/src/lib.rs. */
const RasterMode = { Rgba: 0, Png: 1, Planes: 2 } as const;
type RasterMode = (typeof RasterMode)[keyof typeof RasterMode];

function rasterOp(r: RasterSamples, outW: number, outH: number, mode: RasterMode, level: number, hint: number): Uint8Array {
  return withBytes(r.data, (w, ptr) =>
    run(new Uint8Array(0), hint, () => w.raster(ptr, r.data.length, r.width, r.height, r.channels, r.hasAlpha ? 1 : 0, outW, outH, mode, level)),
  );
}

/** Raster samples → RGBA, resampled to outW × outH. */
export function rasterRgba(r: RasterSamples, outW = r.width, outH = r.height): Uint8Array {
  return rasterOp(r, outW, outH, RasterMode.Rgba, 0, outW * outH * 4);
}

/** Raster samples → PNG (RGBA), resampled to outW × outH. */
export function rasterPng(r: RasterSamples, outW = r.width, outH = r.height, level = 2): Uint8Array {
  return rasterOp(r, outW, outH, RasterMode.Png, level, outW * outH * 2);
}

/** Raster samples → separate RGB and alpha planes (PDF image + soft mask). */
export function rasterPlanes(r: RasterSamples, outW = r.width, outH = r.height): { rgb: Uint8Array; alpha?: Uint8Array } {
  const all = rasterOp(r, outW, outH, RasterMode.Planes, 0, outW * outH * 4);
  const n = outW * outH * 3;
  return { rgb: all.subarray(0, n), alpha: all.length > n ? all.subarray(n) : undefined };
}

/** RGBA pixels → PNG. */
export function pngFromRgba(rgba: Uint8Array, width: number, height: number, level = 6): Uint8Array {
  return withBytes(rgba, (w, ptr) => run(new Uint8Array(0), width * height * 2, () => w.png_rgba(ptr, width, height, level)));
}
