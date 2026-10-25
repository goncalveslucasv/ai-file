// Tokenizer for the native Illustrator stream ("AI text format", a PostScript dialect).
//
// The stream is split into Statements: an operator plus the operands accumulated since the
// previous operator. Statements tile the source exactly (statement i spans
// [start, end) and the next one starts at end), which lets the writer copy untouched
// regions byte-for-byte.
//
// Lexical rules recovered from Illustrator 2026 output:
//  - Lines end with \r (also \n / \r\n accepted).
//  - "%_" anywhere outside a string turns the rest of the line into Illustrator-only
//    content. PostScript sees a comment; Illustrator reads the tokens. Statements whose
//    operator sits in such a region are flagged `hidden`.
//  - Any other "%" starts a comment that runs to the end of the line ("%AI5_BeginLayer",
//    "%%BeginData: N", ASCII85 continuation lines of /Binary values, ...).
//  - "%%BeginData: N" is followed by a line break and exactly N raw bytes. The bytes start
//    with the operator that consumes them ("XI\n" for raster data) and are immediately
//    followed by "%%EndData" (no line break in between).

import { latin1 } from "../bytes.ts";

export type Operand = number | AiStr | AiName | AiHex | AiArray | AiMark;
export interface AiStr {
  t: "s";
  /** Byte string (one char per byte), escapes resolved. */
  v: string;
}
export interface AiName {
  t: "n";
  v: string;
}
export interface AiHex {
  t: "h";
  /** Hex digits, whitespace removed. */
  v: string;
}
export interface AiArray {
  t: "a";
  v: Operand[];
}
export interface AiMark {
  t: "mark";
}

export interface Statement {
  /** Operator name. "%" for comments, "" for operands left dangling before a comment / EOF. */
  op: string;
  args: Operand[];
  /** The operator token is inside a "%_" region. */
  hidden: boolean;
  /** Byte range covering leading whitespace, operands and the operator. */
  start: number;
  end: number;
  /** Comment text without the leading "%" (op === "%"). */
  text?: string;
  /** Raw data range for operators fed by %%BeginData (e.g. XI): [start, end) of the payload. */
  data?: [number, number];
}

const WS = 1, DELIM = 2;
const charClass = new Uint8Array(256);
for (const c of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) charClass[c] = WS;
for (const c of "()<>[]{}/%".split("")) charClass[c.charCodeAt(0)] = DELIM;

export function isStr(o: Operand | undefined): o is AiStr {
  return typeof o === "object" && o !== null && o.t === "s";
}
export function isName(o: Operand | undefined, name?: string): o is AiName {
  return typeof o === "object" && o !== null && o.t === "n" && (name === undefined || o.v === name);
}
export function isArr(o: Operand | undefined): o is AiArray {
  return typeof o === "object" && o !== null && o.t === "a";
}
export function isNum(o: Operand | undefined): o is number {
  return typeof o === "number";
}

export interface LexOptions {
  start?: number;
  end?: number;
}

/**
 * Tokenizes `src[start, end)` into statements.
 * Large binary payloads are never copied: statements only keep offsets.
 */
export function lex(src: Uint8Array, options: LexOptions = {}): Statement[] {
  const end = options.end ?? src.length;
  let pos = options.start ?? 0;
  const out: Statement[] = [];
  let stack: Operand[] = [];
  const marks: number[] = [];
  let stmtStart = pos;
  let hidden = false; // inside a %_ region on the current line

  const flushDangling = (at: number): void => {
    if (stack.length === 0 && at === stmtStart) return;
    if (stack.length === 0) return; // whitespace only: leave it to the next statement
    out.push({ op: "", args: stack, hidden, start: stmtStart, end: at });
    stack = [];
    marks.length = 0;
    stmtStart = at;
  };

  const emit = (op: string, opEnd: number, extra?: Partial<Statement>): void => {
    out.push({ op, args: stack, hidden, start: stmtStart, end: opEnd, ...extra });
    stack = [];
    marks.length = 0;
    stmtStart = opEnd;
  };

  while (pos < end) {
    const c = src[pos];
    if (c === 0x0d || c === 0x0a) {
      hidden = false;
      pos++;
      continue;
    }
    if (charClass[c] === WS) {
      pos++;
      continue;
    }
    if (c === 0x25 /* % */) {
      if (src[pos + 1] === 0x5f /* _ */) {
        hidden = true;
        pos += 2;
        continue;
      }
      // Comment to end of line.
      let e = pos + 1;
      while (e < end && src[e] !== 0x0d && src[e] !== 0x0a) e++;
      const text = latin1(src, pos + 1, e);
      const m = /^%BeginData:\s*(\d+)/.exec(text);
      if (m) {
        // Skip the line break, then the payload. The payload starts with the operator that
        // consumes it ("XI\n"); the pending operands are that operator's arguments.
        let p = e;
        if (src[p] === 0x0d) p++;
        if (src[p] === 0x0a) p++;
        let q = p;
        while (q < end && charClass[src[q]] !== WS) q++;
        const op = latin1(src, p, q);
        let payload = q;
        if (src[payload] === 0x0d) payload++;
        if (src[payload] === 0x0a) payload++;
        const dataEnd = findDataEnd(src, p, payload, Number(m[1]), op, stack, end);
        emit(op, dataEnd, { text, data: [payload, dataEnd] });
        pos = dataEnd;
        hidden = false;
        continue;
      }
      flushDangling(pos);
      emit("%", e, { text });
      pos = e;
      continue;
    }
    if (c === 0x28 /* ( */) {
      const r = readString(src, pos, end);
      stack.push({ t: "s", v: r.value });
      pos = r.end;
      continue;
    }
    if (c === 0x3c /* < */) {
      if (src[pos + 1] === 0x3c) {
        // "<<" never appears in the art stream; treat as an operator for robustness.
        pos += 2;
        emit("<<", pos);
        continue;
      }
      let e = pos + 1;
      let hex = "";
      while (e < end && src[e] !== 0x3e) {
        const ch = src[e];
        if ((ch >= 0x30 && ch <= 0x39) || (ch >= 0x41 && ch <= 0x46) || (ch >= 0x61 && ch <= 0x66)) hex += String.fromCharCode(ch);
        e++;
      }
      stack.push({ t: "h", v: hex });
      pos = e + 1;
      continue;
    }
    if (c === 0x5b /* [ */) {
      marks.push(stack.length);
      stack.push({ t: "mark" });
      pos++;
      continue;
    }
    if (c === 0x5d /* ] */) {
      const m = marks.pop();
      if (m !== undefined) {
        const items = stack.splice(m);
        items.shift();
        stack.push({ t: "a", v: items });
      }
      pos++;
      continue;
    }
    if (c === 0x2f /* / */) {
      let e = pos + 1;
      while (e < end && !charClass[src[e]]) e++;
      stack.push({ t: "n", v: latin1(src, pos + 1, e) });
      pos = e;
      continue;
    }
    if (c === 0x7b || c === 0x7d || c === 0x3e) {
      // Procedures do not occur in Illustrator output; keep them as operators.
      pos++;
      emit(String.fromCharCode(c), pos);
      continue;
    }
    // Number or operator.
    let e = pos + 1;
    while (e < end && !charClass[src[e]]) e++;
    const word = latin1(src, pos, e);
    const n = parseNumber(word);
    if (n !== null) stack.push(n);
    else emit(word, e);
    pos = e;
  }
  flushDangling(end);
  // Trailing whitespace belongs to the last statement so ranges tile the input.
  if (out.length && out[out.length - 1].end < end) out[out.length - 1].end = end;
  return out;
}

/** True when "%%EndData" (optionally preceded by "%_") starts at `at`. */
function endDataAt(src: Uint8Array, at: number, end: number): boolean {
  let p = at;
  if (src[p] === 0x25 && src[p + 1] === 0x5f) p += 2;
  if (p + 9 > end) return p === end;
  return latin1(src, p, p + 9) === "%%EndData";
}

/**
 * Finds the end of a %%BeginData payload. Illustrator writes N = 3 + w*h*colorChannels for
 * rasters but then also stores the alpha plane(s), so N cannot be trusted. Candidates, in order:
 * the declared length, the size implied by the XI operands, then a scan for "%%EndData".
 */
function findDataEnd(src: Uint8Array, lineStart: number, payload: number, declared: number, op: string, args: Operand[], end: number): number {
  const declaredEnd = lineStart + declared;
  if (declaredEnd <= end && endDataAt(src, declaredEnd, end)) return declaredEnd;
  if (op === "XI") {
    const nums = args.filter((a): a is number => typeof a === "number");
    // [matrix] llx lly urx ury width height bits colorChannels alphaChannels reserved binary mask ...
    if (nums.length >= 9) {
      const [, , , , w, h, bits, channels, alpha] = nums;
      const rowBytes = (n: number): number => Math.ceil((w * bits * n) / 8);
      const size = rowBytes(channels) * h + rowBytes(1) * h * alpha;
      if (payload + size <= end && endDataAt(src, payload + size, end)) return payload + size;
    }
  }
  for (let i = Math.min(declaredEnd, end); i + 9 <= end; i++) {
    if (src[i] === 0x25 && src[i + 1] === 0x25 && latin1(src, i, i + 9) === "%%EndData") {
      return src[i - 2] === 0x25 && src[i - 1] === 0x5f ? i - 2 : i;
    }
  }
  return Math.min(declaredEnd, end);
}

function parseNumber(word: string): number | null {
  const c = word.charCodeAt(0);
  if (!((c >= 0x30 && c <= 0x39) || c === 0x2d || c === 0x2b || c === 0x2e)) return null;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(word)) return null;
  return Number(word);
}

function readString(src: Uint8Array, pos: number, end: number): { value: string; end: number } {
  let p = pos + 1;
  let depth = 1;
  let out = "";
  while (p < end) {
    const c = src[p++];
    if (c === 0x5c /* \ */) {
      const n = src[p++];
      switch (n) {
        case 0x6e: out += "\n"; break;
        case 0x72: out += "\r"; break;
        case 0x74: out += "\t"; break;
        case 0x62: out += "\b"; break;
        case 0x66: out += "\f"; break;
        case 0x0d:
          if (src[p] === 0x0a) p++;
          break;
        case 0x0a:
          break;
        default:
          if (n >= 0x30 && n <= 0x37) {
            let v = n - 0x30;
            for (let k = 0; k < 2 && src[p] >= 0x30 && src[p] <= 0x37; k++) v = v * 8 + (src[p++] - 0x30);
            out += String.fromCharCode(v & 0xff);
          } else out += String.fromCharCode(n);
      }
      continue;
    }
    if (c === 0x28) depth++;
    else if (c === 0x29 && --depth === 0) break;
    out += String.fromCharCode(c);
  }
  return { value: out, end: p };
}

/** Escapes a byte string for use inside "( )". */
export function escapeString(v: string): string {
  let out = "";
  for (let i = 0; i < v.length; i++) {
    const ch = v[i];
    const code = v.charCodeAt(i);
    if (ch === "(" || ch === ")" || ch === "\\") out += "\\" + ch;
    else if (ch === "\r") out += "\\r";
    else if (ch === "\n") out += "\\n";
    else if (code < 0x20 || code > 0x7e) out += "\\" + code.toString(8).padStart(3, "0");
    else out += ch;
  }
  return out;
}

/** Serializes an operand back to AI syntax. */
export function formatOperand(o: Operand, fmtNum: (n: number) => string): string {
  if (typeof o === "number") return fmtNum(o);
  switch (o.t) {
    case "s": return "(" + escapeString(o.v) + ")";
    case "n": return "/" + o.v;
    case "h": return "<" + o.v + ">";
    case "a": return "[" + o.v.map((x) => formatOperand(x, fmtNum)).join(" ") + "]";
    case "mark": return "[";
  }
}
