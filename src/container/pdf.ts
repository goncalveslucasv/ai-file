// Minimal, read-only PDF object reader. It only implements what is needed to reach the
// Illustrator private data inside a PDF-compatible .ai file: cross-reference tables
// (classic and stream based, including incremental updates), indirect objects, object
// streams and Flate-decoded streams.

import { inflate } from "../wasm/codec.ts";
import { indexOf, lastIndexOf, latin1 } from "../bytes.ts";

export interface PdfRef {
  kind: "ref";
  num: number;
  gen: number;
}
export interface PdfName {
  kind: "name";
  name: string;
}
export interface PdfString {
  kind: "string";
  /** Raw bytes as a byte string (one char per byte). */
  value: string;
}
export interface PdfStream {
  kind: "stream";
  dict: PdfDict;
  /** Offset of the first data byte in the file. */
  start: number;
  /** Length of the raw (still encoded) data. */
  length: number;
}
export type PdfDict = Map<string, PdfValue>;
export type PdfValue = number | boolean | null | PdfRef | PdfName | PdfString | PdfValue[] | PdfDict | PdfStream;

interface XrefEntry {
  type: 1 | 2;
  /** type 1: file offset. type 2: object stream number. */
  a: number;
  /** type 2: index inside the object stream. */
  b: number;
}

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

class ObjectParser {
  pos: number;
  readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array, pos: number) {
    this.bytes = bytes;
    this.pos = pos;
  }

  private skipWs(): void {
    const b = this.bytes;
    while (this.pos < b.length) {
      const c = b[this.pos];
      if (WS.has(c)) this.pos++;
      else if (c === 0x25) {
        while (this.pos < b.length && b[this.pos] !== 0x0a && b[this.pos] !== 0x0d) this.pos++;
      } else break;
    }
  }

  private word(): string {
    const b = this.bytes;
    const s = this.pos;
    while (this.pos < b.length && !WS.has(b[this.pos]) && !DELIM.has(b[this.pos])) this.pos++;
    return latin1(b, s, this.pos);
  }

  value(): PdfValue {
    this.skipWs();
    const b = this.bytes;
    const c = b[this.pos];
    if (c === 0x2f) {
      this.pos++;
      return { kind: "name", name: this.word().replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) };
    }
    if (c === 0x3c && b[this.pos + 1] === 0x3c) {
      this.pos += 2;
      const dict: PdfDict = new Map();
      for (;;) {
        this.skipWs();
        if (b[this.pos] === 0x3e && b[this.pos + 1] === 0x3e) {
          this.pos += 2;
          break;
        }
        const key = this.value();
        if (typeof key !== "object" || key === null || !("kind" in key) || key.kind !== "name") throw new Error(`Bad PDF dictionary key at ${this.pos}`);
        dict.set(key.name, this.value());
      }
      this.skipWs();
      if (latin1(b, this.pos, this.pos + 6) === "stream") {
        this.pos += 6;
        if (b[this.pos] === 0x0d) this.pos++;
        if (b[this.pos] === 0x0a) this.pos++;
        return { kind: "stream", dict, start: this.pos, length: -1 };
      }
      return dict;
    }
    if (c === 0x3c) {
      const end = indexOf(b, ">", this.pos);
      const hex = latin1(b, this.pos + 1, end).replace(/\s+/g, "");
      this.pos = end + 1;
      let v = "";
      for (let i = 0; i < hex.length; i += 2) v += String.fromCharCode(parseInt((hex[i] + (hex[i + 1] ?? "0")), 16));
      return { kind: "string", value: v };
    }
    if (c === 0x28) return { kind: "string", value: this.literal() };
    if (c === 0x5b) {
      this.pos++;
      const arr: PdfValue[] = [];
      for (;;) {
        this.skipWs();
        if (b[this.pos] === 0x5d) {
          this.pos++;
          break;
        }
        arr.push(this.value());
      }
      return arr;
    }
    const w = this.word();
    if (w === "true") return true;
    if (w === "false") return false;
    if (w === "null") return null;
    const n = Number(w);
    if (Number.isNaN(n)) throw new Error(`Unexpected PDF token "${w}" at ${this.pos}`);
    // Lookahead for "num gen R".
    const save = this.pos;
    this.skipWs();
    const w2 = this.word();
    if (/^\d+$/.test(w2)) {
      this.skipWs();
      if (b[this.pos] === 0x52 /* R */) {
        this.pos++;
        return { kind: "ref", num: n, gen: Number(w2) };
      }
    }
    this.pos = save;
    return n;
  }

  private literal(): string {
    const b = this.bytes;
    this.pos++;
    let depth = 1;
    let out = "";
    while (this.pos < b.length) {
      const c = b[this.pos++];
      if (c === 0x5c) {
        const n = b[this.pos++];
        const map: Record<number, string> = { 0x6e: "\n", 0x72: "\r", 0x74: "\t", 0x62: "\b", 0x66: "\f" };
        if (map[n] !== undefined) out += map[n];
        else if (n >= 0x30 && n <= 0x37) {
          let oct = String.fromCharCode(n);
          for (let k = 0; k < 2 && b[this.pos] >= 0x30 && b[this.pos] <= 0x37; k++) oct += String.fromCharCode(b[this.pos++]);
          out += String.fromCharCode(parseInt(oct, 8) & 0xff);
        } else if (n === 0x0d) {
          if (b[this.pos] === 0x0a) this.pos++;
        } else if (n !== 0x0a) out += String.fromCharCode(n);
        continue;
      }
      if (c === 0x28) depth++;
      else if (c === 0x29 && --depth === 0) break;
      out += String.fromCharCode(c);
    }
    return out;
  }
}

export function isName(v: PdfValue | undefined, name?: string): v is PdfName {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Map) && v.kind === "name" && (name === undefined || v.name === name);
}

export function isRef(v: PdfValue | undefined): v is PdfRef {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Map) && v.kind === "ref";
}

export function isStream(v: PdfValue | undefined): v is PdfStream {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Map) && v.kind === "stream";
}

export class PdfReader {
  readonly bytes: Uint8Array;
  readonly xref = new Map<number, XrefEntry>();
  trailer: PdfDict = new Map();
  private cache = new Map<number, PdfValue>();
  private objStreams = new Map<number, { offsets: number[]; data: Uint8Array; first: number }>();

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.readXref();
  }

  private readXref(): void {
    const b = this.bytes;
    const sx = lastIndexOf(b, "startxref");
    if (sx < 0) throw new Error("PDF: startxref not found");
    let pos = Number(/startxref\s+(\d+)/.exec(latin1(b, sx, Math.min(b.length, sx + 64)))?.[1]);
    const seen = new Set<number>();
    let first = true;
    while (Number.isFinite(pos) && !seen.has(pos)) {
      seen.add(pos);
      let trailer: PdfDict;
      if (latin1(b, pos, pos + 4) === "xref") trailer = this.readClassicXref(pos);
      else trailer = this.readXrefStream(pos);
      if (first) {
        this.trailer = trailer;
        first = false;
      }
      const stm = trailer.get("XRefStm");
      if (typeof stm === "number" && !seen.has(stm)) {
        seen.add(stm);
        this.readXrefStream(stm);
      }
      const prev = trailer.get("Prev");
      pos = typeof prev === "number" ? prev : NaN;
    }
  }

  private readClassicXref(pos: number): PdfDict {
    const b = this.bytes;
    let i = pos + 4;
    const readLine = (): string => {
      while (b[i] === 0x0d || b[i] === 0x0a || b[i] === 0x20) i++;
      const s = i;
      while (i < b.length && b[i] !== 0x0d && b[i] !== 0x0a) i++;
      return latin1(b, s, i).trim();
    };
    for (;;) {
      const save = i;
      const line = readLine();
      if (line.startsWith("trailer")) {
        i = save;
        break;
      }
      const m = /^(\d+)\s+(\d+)$/.exec(line);
      if (!m) throw new Error(`PDF: bad xref subsection header "${line}"`);
      const start = Number(m[1]);
      const count = Number(m[2]);
      while (b[i] === 0x0d || b[i] === 0x0a || b[i] === 0x20) i++;
      for (let k = 0; k < count; k++) {
        const entry = latin1(b, i, i + 20);
        i += 20;
        const num = start + k;
        if (entry[17] === "n" && !this.xref.has(num)) this.xref.set(num, { type: 1, a: Number(entry.slice(0, 10)), b: 0 });
        else if (entry[17] === "f" && !this.xref.has(num)) this.xref.set(num, { type: 1, a: -1, b: 0 });
      }
    }
    const t = indexOf(b, "trailer", i);
    const parser = new ObjectParser(b, t + 7);
    return parser.value() as PdfDict;
  }

  private readXrefStream(pos: number): PdfDict {
    const parser = new ObjectParser(this.bytes, pos);
    parser.value(); // obj number
    parser.value(); // generation
    const objKw = indexOf(this.bytes, "obj", parser.pos);
    parser.pos = objKw + 3;
    const stream = parser.value();
    if (!isStream(stream)) throw new Error("PDF: xref stream expected");
    stream.length = this.resolveLength(stream);
    const data = this.decodeStream(stream);
    const w = (stream.dict.get("W") as number[]).map(Number);
    const size = Number(stream.dict.get("Size"));
    const index = (stream.dict.get("Index") as number[] | undefined) ?? [0, size];
    const rowLen = w[0] + w[1] + w[2];
    let row = 0;
    const field = (off: number, len: number, def: number): number => {
      if (len === 0) return def;
      let v = 0;
      for (let k = 0; k < len; k++) v = v * 256 + data[off + k];
      return v;
    };
    for (let s = 0; s < index.length; s += 2) {
      for (let k = 0; k < index[s + 1]; k++, row++) {
        const off = row * rowLen;
        const type = field(off, w[0], 1);
        const a = field(off + w[0], w[1], 0);
        const bb = field(off + w[0] + w[1], w[2], 0);
        const num = index[s] + k;
        if (this.xref.has(num)) continue;
        if (type === 1) this.xref.set(num, { type: 1, a, b: 0 });
        else if (type === 2) this.xref.set(num, { type: 2, a, b: bb });
        else this.xref.set(num, { type: 1, a: -1, b: 0 });
      }
    }
    return stream.dict;
  }

  private resolveLength(stream: PdfStream): number {
    const len = stream.dict.get("Length");
    if (typeof len === "number") return len;
    if (isRef(len)) {
      const v = this.get(len.num);
      if (typeof v === "number") return v;
    }
    // Fallback: scan for endstream.
    const end = indexOf(this.bytes, "endstream", stream.start);
    let e = end;
    while (e > stream.start && (this.bytes[e - 1] === 0x0a || this.bytes[e - 1] === 0x0d)) e--;
    return e - stream.start;
  }

  /** Returns the object with the given number (resolving object streams). */
  get(num: number): PdfValue {
    if (this.cache.has(num)) return this.cache.get(num)!;
    const entry = this.xref.get(num);
    if (!entry || entry.a < 0) return null;
    let value: PdfValue;
    if (entry.type === 1) {
      const parser = new ObjectParser(this.bytes, entry.a);
      parser.value();
      parser.value();
      const objKw = indexOf(this.bytes, "obj", parser.pos);
      parser.pos = objKw + 3;
      value = parser.value();
      if (isStream(value)) value.length = this.resolveLength(value);
    } else {
      value = this.getFromObjectStream(entry.a, entry.b);
    }
    this.cache.set(num, value);
    return value;
  }

  private getFromObjectStream(streamNum: number, index: number): PdfValue {
    let os = this.objStreams.get(streamNum);
    if (!os) {
      const s = this.get(streamNum);
      if (!isStream(s)) throw new Error("PDF: object stream expected");
      const data = this.decodeStream(s);
      const n = Number(s.dict.get("N"));
      const first = Number(s.dict.get("First"));
      const header = latin1(data, 0, first).trim().split(/\s+/).map(Number);
      const offsets: number[] = [];
      for (let k = 0; k < n; k++) offsets.push(header[k * 2 + 1]);
      os = { offsets, data, first };
      this.objStreams.set(streamNum, os);
    }
    const parser = new ObjectParser(os.data, os.first + os.offsets[index]);
    return parser.value();
  }

  resolve(v: PdfValue | undefined): PdfValue | undefined {
    let cur = v;
    for (let guard = 0; isRef(cur) && guard < 32; guard++) cur = this.get(cur.num);
    return cur;
  }

  /** Raw (still encoded) stream bytes, as a view into the file. */
  rawStream(stream: PdfStream): Uint8Array {
    return this.bytes.subarray(stream.start, stream.start + stream.length);
  }

  /** Decoded stream bytes. Supports FlateDecode (with PNG/TIFF predictors) and no filter. */
  decodeStream(stream: PdfStream): Uint8Array {
    let data = this.rawStream(stream);
    const filter = this.resolve(stream.dict.get("Filter"));
    const filters = Array.isArray(filter) ? filter : filter ? [filter] : [];
    const parmsRaw = this.resolve(stream.dict.get("DecodeParms"));
    const parmsList = Array.isArray(parmsRaw) ? parmsRaw : [parmsRaw];
    filters.forEach((f, idx) => {
      if (!isName(f)) return;
      if (f.name === "FlateDecode") {
        try {
          data = inflate(data, "auto", { sizeHint: data.length * 4 });
        } catch {
          // Damaged zlib header or checksum: retry as raw deflate after the 2-byte header.
          data = inflate(data.subarray(2), "raw", { sizeHint: data.length * 4 });
        }
        const parms = parmsList[idx];
        if (parms instanceof Map) data = applyPredictor(data, parms);
      } else {
        throw new Error(`PDF: unsupported filter ${f.name}`);
      }
    });
    return data;
  }
}

function applyPredictor(data: Uint8Array, parms: PdfDict): Uint8Array {
  const predictor = Number(parms.get("Predictor") ?? 1);
  if (predictor < 10) return data;
  const colors = Number(parms.get("Colors") ?? 1);
  const bpc = Number(parms.get("BitsPerComponent") ?? 8);
  const columns = Number(parms.get("Columns") ?? 1);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)];
    const src = r * (rowLen + 1) + 1;
    const dst = r * rowLen;
    for (let i = 0; i < rowLen; i++) {
      const raw = data[src + i];
      const left = i >= bpp ? out[dst + i - bpp] : 0;
      const up = r > 0 ? out[dst - rowLen + i] : 0;
      const ul = r > 0 && i >= bpp ? out[dst - rowLen + i - bpp] : 0;
      let v: number;
      switch (type) {
        case 1: v = raw + left; break;
        case 2: v = raw + up; break;
        case 3: v = raw + ((left + up) >> 1); break;
        case 4: {
          const p = left + up - ul;
          const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - ul);
          v = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul);
          break;
        }
        default: v = raw;
      }
      out[dst + i] = v & 0xff;
    }
  }
  return out;
}
