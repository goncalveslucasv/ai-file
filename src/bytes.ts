// Small byte helpers shared by the container, lexer and writers.

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const utf8Encoder = new TextEncoder();

/** Decodes bytes 1:1 into a JS string (each byte becomes one UTF-16 code unit). */
export function latin1(bytes: Uint8Array, start = 0, end = bytes.length): string {
  // TextDecoder("latin1") is really windows-1252; decode manually for exact 0x80-0x9F round-trips.
  let out = "";
  const CHUNK = 0x8000;
  for (let i = start; i < end; i += CHUNK) {
    out += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, Math.min(end, i + CHUNK))));
  }
  return out;
}

/** Encodes a string whose code units are all < 256 back into bytes. */
export function fromLatin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

export function utf8(text: string): Uint8Array {
  return utf8Encoder.encode(text);
}

/** Interprets a byte string as UTF-8 when valid, otherwise as latin1. */
export function decodeMaybeUtf8(raw: string): string {
  if (!/[\x80-\xff]/.test(raw)) return raw;
  try {
    return utf8Decoder.decode(fromLatin1(raw));
  } catch {
    return raw;
  }
}

/** Encodes a JS string as UTF-8 and returns it as a byte string (one char per byte). */
export function toUtf8ByteString(text: string): string {
  if (!/[^\x00-\x7f]/.test(text)) return text;
  return latin1(utf8(text));
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

export function startsWith(bytes: Uint8Array, prefix: string, at = 0): boolean {
  if (at + prefix.length > bytes.length) return false;
  for (let i = 0; i < prefix.length; i++) if (bytes[at + i] !== prefix.charCodeAt(i)) return false;
  return true;
}

/** Finds `needle` (ASCII) in `bytes` starting at `from`; returns -1 when absent. */
export function indexOf(bytes: Uint8Array, needle: string, from = 0, to = bytes.length): number {
  const first = needle.charCodeAt(0);
  const last = to - needle.length;
  outer: for (let i = from; i <= last; i++) {
    if (bytes[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

export function lastIndexOf(bytes: Uint8Array, needle: string, from = bytes.length - needle.length): number {
  const first = needle.charCodeAt(0);
  outer: for (let i = Math.min(from, bytes.length - needle.length); i >= 0; i--) {
    if (bytes[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

/** Growable byte buffer used by the writers. Large payloads are kept as separate chunks (no copy). */
export class ByteWriter {
  private chunks: Uint8Array[] = [];
  private buf = new Uint8Array(1 << 16);
  private used = 0;
  length = 0;

  private flush(): void {
    if (this.used === 0) return;
    this.chunks.push(this.buf.slice(0, this.used));
    this.used = 0;
  }

  bytes(data: Uint8Array): this {
    if (data.length > 1 << 16) {
      this.flush();
      this.chunks.push(data);
    } else {
      if (this.used + data.length > this.buf.length) this.flush();
      this.buf.set(data, this.used);
      this.used += data.length;
    }
    this.length += data.length;
    return this;
  }

  /** Appends a byte string (chars < 256). */
  str(text: string): this {
    if (text.length > 1 << 15) return this.bytes(fromLatin1(text));
    if (this.used + text.length > this.buf.length) this.flush();
    for (let i = 0; i < text.length; i++) this.buf[this.used + i] = text.charCodeAt(i) & 0xff;
    this.used += text.length;
    this.length += text.length;
    return this;
  }

  toBytes(): Uint8Array {
    this.flush();
    if (this.chunks.length === 1) return this.chunks[0];
    return concatBytes(this.chunks);
  }

  /** The chunks written so far (avoids one large concatenation). */
  toChunks(): Uint8Array[] {
    this.flush();
    return this.chunks;
  }
}

/**
 * Formats a number the way Illustrator does: shortest round-trip decimal, never exponent
 * notation. `digits` caps the number of decimals (default: as many as needed).
 */
export function fmt(n: number, digits?: number): string {
  if (!Number.isFinite(n)) return "0";
  let v = digits === undefined ? n : Number(n.toFixed(Math.min(20, digits)));
  if (Object.is(v, -0)) v = 0;
  let s = String(v);
  if (/e/i.test(s)) {
    s = Math.abs(v) < 1 ? v.toFixed(20) : v.toFixed(0);
    if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  }
  return s === "-0" ? "0" : s;
}
