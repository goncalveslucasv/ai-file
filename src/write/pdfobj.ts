// Tiny PDF object serializer used by the .ai writers.

import { ByteWriter, fmt } from "../bytes.ts";

export interface PName {
  n: string;
}
export interface PRef {
  r: number;
}
export interface PRaw {
  raw: string;
}
export type PVal = number | boolean | null | string | PName | PRef | PRaw | PVal[] | { [k: string]: PVal | undefined };

export const name = (n: string): PName => ({ n });
export const ref = (r: number): PRef => ({ r });
export const raw = (s: string): PRaw => ({ raw: s });

export function pdfString(s: string): string {
  let out = "(";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ch = s[i];
    if (ch === "(" || ch === ")" || ch === "\\") out += "\\" + ch;
    else if (c < 0x20 || c > 0x7e) out += "\\" + (c & 0xff).toString(8).padStart(3, "0");
    else out += ch;
  }
  return out + ")";
}

export function pdfValue(v: PVal | undefined): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return fmt(v, 6);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return pdfString(v);
  if (Array.isArray(v)) return "[" + v.map(pdfValue).join(" ") + "]";
  if ("n" in v && typeof v.n === "string" && Object.keys(v).length === 1) return "/" + v.n.replace(/[^!-~]|[#()<>[\]{}/%]/g, (c) => "#" + c.charCodeAt(0).toString(16).padStart(2, "0"));
  if ("r" in v && typeof v.r === "number" && Object.keys(v).length === 1) return `${v.r} 0 R`;
  if ("raw" in v && typeof v.raw === "string" && Object.keys(v).length === 1) return v.raw;
  const parts: string[] = [];
  for (const [k, x] of Object.entries(v)) if (x !== undefined) parts.push("/" + k + " " + pdfValue(x));
  return "<<" + parts.join("") + ">>";
}

/** Sequential PDF file builder (classic cross-reference table). */
export class PdfBuilder {
  readonly out = new ByteWriter();
  readonly offsets = new Map<number, number>();
  private nextNum: number;

  constructor(firstFreeNumber = 1, header = "%PDF-1.6\r%\xe2\xe3\xcf\xd3\r\n") {
    this.nextNum = firstFreeNumber;
    this.out.str(header);
  }

  alloc(): number {
    return this.nextNum++;
  }

  get size(): number {
    return this.nextNum;
  }

  reserveUpTo(n: number): void {
    if (n >= this.nextNum) this.nextNum = n + 1;
  }

  /** Writes raw object bytes (a complete "n 0 obj ... endobj") for object `num`. */
  rawObject(num: number, bytes: Uint8Array): void {
    this.offsets.set(num, this.out.length);
    this.out.bytes(bytes);
    this.out.str("\r");
  }

  object(num: number, value: PVal): void {
    this.offsets.set(num, this.out.length);
    this.out.str(`${num} 0 obj\r${pdfValue(value)}\rendobj\r`);
  }

  stream(num: number, dict: { [k: string]: PVal | undefined }, data: Uint8Array): void {
    this.offsets.set(num, this.out.length);
    this.out.str(`${num} 0 obj\r${pdfValue({ ...dict, Length: data.length })}stream\r\n`);
    this.out.bytes(data);
    this.out.str("\rendstream\rendobj\r");
  }

  finish(trailer: { [k: string]: PVal | undefined }): Uint8Array {
    const size = Math.max(this.nextNum, ...[...this.offsets.keys()].map((k) => k + 1));
    const xrefAt = this.out.length;
    this.out.str(`xref\r\n0 ${size}\r\n`);
    this.out.str("0000000000 65535 f\r\n");
    for (let i = 1; i < size; i++) {
      const off = this.offsets.get(i);
      this.out.str(off === undefined ? "0000000000 00000 f\r\n" : `${String(off).padStart(10, "0")} 00000 n\r\n`);
    }
    this.out.str(`trailer\r\n${pdfValue({ ...trailer, Size: size })}\r\nstartxref\r\n${xrefAt}\r\n%%EOF\r\n`);
    return this.out.toBytes();
  }
}
