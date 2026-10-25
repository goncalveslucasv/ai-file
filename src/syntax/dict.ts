// Parser/writer for the postfix "dictionary language" Illustrator uses for art dictionaries,
// document data, art styles, text objects and other structured payloads:
//
//   /ArtDictionary :                               open a container of type ArtDictionary
//   1 /Real (Raster Art Original Scale) ,          typed keyed value
//   (Chain Style Filter) 0 0 /Filter ,             attribute (values + /Name)
//   /NotRecorded ,                                 flag attribute
//   7621.6 9673.6 /RealPoint (RulerOrigin) ,       multi-number typed value
//   /Dictionary : ... ; (key) ,                    nested container stored under a key
//   /Array : ... ; ,                               "," without operands appends the last closed container
//   /XMLUID : (Layer_1) ; (AI10_ArtUID) ,          ";" may carry the container's own value
//   /FillStyle : 0 O ... Xd /Def ;                 containers may hold plain operators (paint styles)
//   ... ; /Dict ;                                  "/Name ;" adopts the last closed container under Name, then closes
//   /Binary : /ASCII85Decode , %<a85 data>~> ; ,   binary payload on comment lines
//
// The same grammar appears with and without the "%_" prefix.

import { decodeMaybeUtf8, fmt, toUtf8ByteString } from "../bytes.ts";
import { formatOperand, isName, isStr, type Operand, type Statement } from "./lexer.ts";

export interface DictNode {
  type: string;
  entries: DictEntry[];
  /** Plain operators inside the container (paint style definitions). */
  ops: Statement[];
  /** Operands given to the closing ";" (e.g. [/Def], [(Layer_1)]). */
  close: Operand[];
  /** Decoded payload of /Binary containers. */
  binary?: Uint8Array;
}

export interface DictEntry {
  /** Set for "value /Type (key) ," and "; (key) ," entries. */
  key?: string;
  /** Set for "values /Name ," attribute entries (and "/Name ;" adoptions). */
  attr?: string;
  /** Value type name for typed entries (Real, Int, Bool, String, UnicodeString, RealPoint, ...). */
  valueType?: string;
  values: Operand[];
  node?: DictNode;
  /** Container adopted by "/Name ;" (the parent closes right after). */
  adopted?: boolean;
}

const VALUE_TYPES = new Set(["Real", "Int", "Bool", "String", "UnicodeString", "RealPoint", "RealPointRelToROrigin", "RealMatrix", "Point", "Matrix", "Long"]);

export interface DictParseResult {
  /** Top-level containers in order (normally exactly one). */
  roots: DictNode[];
  /** Index of the first statement after the block. */
  next: number;
}

/**
 * Parses a dictionary-language block starting at `stmts[start]` (a ":" statement) and stops when
 * every opened container has been closed (and its trailing "," consumed, if any).
 */
export function parseDictBlock(stmts: Statement[], start: number, limit = stmts.length): DictParseResult {
  const roots: DictNode[] = [];
  const stack: DictNode[] = [];
  let lastClosed: DictNode | null = null;
  let lastClosedAttached = true;
  let binaryText: string | null = null;
  let i = start;

  const attach = (entry: DictEntry): void => {
    if (stack.length) stack[stack.length - 1].entries.push(entry);
  };

  for (; i < limit; i++) {
    const s = stmts[i];
    if (s.op === "%") {
      if (binaryText !== null) binaryText += (s.text ?? "").trim();
      continue;
    }
    if (s.op === ":") {
      const typeName = [...s.args].reverse().find((a) => isName(a));
      const node: DictNode = { type: typeName && isName(typeName) ? typeName.v : "?", entries: [], ops: [], close: [] };
      stack.push(node);
      lastClosedAttached = true;
      if (node.type === "Binary") binaryText = "";
      continue;
    }
    if (stack.length === 0) {
      // A "," right after the outermost container closed (e.g. "; ," at top level).
      if (s.op === "," && lastClosed && !lastClosedAttached) {
        lastClosedAttached = true;
        continue;
      }
      break;
    }
    const cur = stack[stack.length - 1];
    if (s.op === ";") {
      const last = s.args[s.args.length - 1];
      if (isName(last) && lastClosed && !lastClosedAttached) {
        cur.entries.push({ attr: last.v, values: [], node: lastClosed, adopted: true });
        lastClosedAttached = true;
      }
      cur.close = s.args;
      if (binaryText !== null) {
        cur.binary = decodeAscii85(binaryText);
        binaryText = null;
      }
      stack.pop();
      lastClosed = cur;
      lastClosedAttached = false;
      if (stack.length === 0) {
        roots.push(cur);
        // Swallow a directly following "," that would attach it to nothing.
        const nx = stmts[i + 1];
        if (nx && nx.op === "," && nx.args.length === 0) i++;
        i++;
        break;
      }
      continue;
    }
    if (s.op === ",") {
      const args = s.args;
      if (args.length === 0) {
        if (lastClosed && !lastClosedAttached) {
          attach({ values: [], node: lastClosed });
          lastClosedAttached = true;
        }
        continue;
      }
      const last = args[args.length - 1];
      if (args.length === 1 && isName(last) && lastClosed && !lastClosedAttached) {
        attach({ attr: last.v, values: [], node: lastClosed });
        lastClosedAttached = true;
        continue;
      }
      if (args.length === 1 && isStr(last) && lastClosed && !lastClosedAttached) {
        attach({ key: last.v, values: [], node: lastClosed });
        lastClosedAttached = true;
        continue;
      }
      if (isStr(last) && args.length >= 2 && isName(args[args.length - 2])) {
        const t = args[args.length - 2] as { t: "n"; v: string };
        attach({ key: last.v, valueType: t.v, values: args.slice(0, -2) });
        continue;
      }
      if (isName(last)) {
        if (cur.type === "Array" && VALUE_TYPES.has(last.v)) attach({ valueType: last.v, values: args.slice(0, -1) });
        else attach({ attr: last.v, values: args.slice(0, -1) });
        if (last.v === "ASCII85Decode") binaryText = "";
        continue;
      }
      attach({ values: args.slice() });
      continue;
    }
    cur.ops.push(s);
  }
  return { roots, next: i };
}

// ---------------------------------------------------------------------------------------------
// Accessors

export function findEntry(node: DictNode | undefined, key: string): DictEntry | undefined {
  return node?.entries.find((e) => e.key === key || e.attr === key);
}

export function getNode(node: DictNode | undefined, key: string): DictNode | undefined {
  return findEntry(node, key)?.node;
}

/** Depth-first search for the first entry with the given key. */
export function findEntryDeep(node: DictNode | undefined, key: string): DictEntry | undefined {
  if (!node) return undefined;
  const direct = findEntry(node, key);
  if (direct) return direct;
  for (const e of node.entries) {
    const hit = e.node ? findEntryDeep(e.node, key) : undefined;
    if (hit) return hit;
  }
  return undefined;
}

/** Converts a typed entry to a JS value. */
export function entryValue(e: DictEntry | undefined): unknown {
  if (!e) return undefined;
  if (e.node) return e.node;
  const v = e.values;
  switch (e.valueType) {
    case "Real":
    case "Int":
    case "Long":
      return typeof v[0] === "number" ? v[0] : Number(isStr(v[0]) ? v[0].v : NaN);
    case "Bool":
      return v[0] === 1 || (isName(v[0]) && v[0].v === "true");
    case "String":
      return isStr(v[0]) ? v[0].v : "";
    case "UnicodeString":
      return isStr(v[0]) ? decodeMaybeUtf8(v[0].v) : "";
    case "RealPoint":
    case "RealPointRelToROrigin":
    case "Point":
      return [Number(v[0]), Number(v[1])];
    case "RealMatrix":
    case "Matrix":
      return v.slice(0, 6).map(Number);
  }
  if (v.length === 1) return isStr(v[0]) ? v[0].v : v[0];
  return v;
}

export function getValue(node: DictNode | undefined, key: string): unknown {
  return entryValue(findEntry(node, key));
}

/** Converts a container into plain JSON (for inspection / debugging). */
export function dictToJson(node: DictNode): unknown {
  if (node.type === "Array") return node.entries.map((e) => (e.node ? dictToJson(e.node) : entryValue(e)));
  const out: Record<string, unknown> = { "@type": node.type };
  if (node.close.length) out["@close"] = node.close.map((o) => (isStr(o) ? o.v : isName(o) ? "/" + o.v : o));
  if (node.binary) out["@binary"] = node.binary.length + " bytes";
  if (node.ops.length) out["@ops"] = node.ops.map((s) => s.op);
  node.entries.forEach((e, idx) => {
    const k = e.key ?? (e.attr ? "/" + e.attr : `#${idx}`);
    out[k] = e.node ? dictToJson(e.node) : entryValue(e);
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Writing

export interface DictWriteOptions {
  /** Prefix every line with "%_" (Illustrator-only content). */
  hidden?: boolean;
  /** Serializes plain operator statements held in `ops`. */
  writeOp?: (s: Statement) => string;
}

export function writeDict(node: DictNode, opts: DictWriteOptions = {}): string[] {
  const lines: string[] = [];
  const num = (n: number): string => fmt(n);
  const op = (o: Operand): string => formatOperand(o, num);
  const closeLine = (n: DictNode): string => {
    const last = n.entries[n.entries.length - 1];
    if (last?.adopted && last.attr) return `/${last.attr} ;`;
    return n.close.length ? `${n.close.map(op).join(" ")} ;` : ";";
  };
  const emit = (n: DictNode): void => {
    lines.push(`/${n.type} :`);
    if (n.binary) {
      lines.push("/ASCII85Decode ,");
      const a85 = encodeAscii85(n.binary);
      for (let k = 0; k < a85.length; k += 100) lines.push("%" + a85.slice(k, k + 100));
    }
    for (const s of n.ops) lines.push(opts.writeOp ? opts.writeOp(s) : [...s.args.map(op), s.op].join(" "));
    for (const e of n.entries) {
      if (n.binary && e.attr === "ASCII85Decode") continue;
      if (e.node) {
        emit(e.node);
        const close = closeLine(e.node);
        if (e.adopted) lines.push(close);
        else if (e.key !== undefined) lines.push(`${close} (${escape(e.key)}) ,`);
        else if (e.attr) lines.push(`${close} /${e.attr} ,`);
        else lines.push(`${close} ,`);
        continue;
      }
      const vals = e.values.map(op).join(" ");
      if (e.key !== undefined) lines.push(`${vals}${vals ? " " : ""}/${e.valueType ?? "String"} (${escape(e.key)}) ,`);
      else if (e.attr) lines.push(`${vals}${vals ? " " : ""}/${e.attr} ,`);
      else lines.push(`${vals}${e.valueType ? " /" + e.valueType : ""} ,`);
    }
  };
  emit(node);
  lines.push(closeLine(node));
  return opts.hidden ? lines.map((l) => (l.startsWith("%") ? l : "%_" + l)) : lines;
}

function escape(s: string): string {
  return s.replace(/[\\()]/g, (c) => "\\" + c);
}

/** Builds a typed entry with a JS value. */
export function typedEntry(key: string, value: string | number | boolean | [number, number], valueType?: string): DictEntry {
  if (typeof value === "number") return { key, valueType: valueType ?? (Number.isInteger(value) ? "Int" : "Real"), values: [value] };
  if (typeof value === "boolean") return { key, valueType: "Bool", values: [value ? 1 : 0] };
  if (Array.isArray(value)) return { key, valueType: valueType ?? "RealPoint", values: value };
  return { key, valueType: valueType ?? "UnicodeString", values: [{ t: "s", v: valueType === "String" ? value : toUtf8ByteString(value) }] };
}

// ---------------------------------------------------------------------------------------------
// ASCII85

export function decodeAscii85(text: string): Uint8Array {
  const s = text.replace(/\s+/g, "").replace(/^<~/, "");
  const endIdx = s.indexOf("~>");
  const body = endIdx >= 0 ? s.slice(0, endIdx) : s;
  const out: number[] = [];
  let group: number[] = [];
  for (const ch of body) {
    if (ch === "z" && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const c = ch.charCodeAt(0) - 33;
    if (c < 0 || c > 84) continue;
    group.push(c);
    if (group.length === 5) {
      let v = 0;
      for (const g of group) v = v * 85 + g;
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      group = [];
    }
  }
  if (group.length) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const g of group) v = v * 85 + g;
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...bytes.slice(0, n - 1));
  }
  return Uint8Array.from(out);
}

export function encodeAscii85(data: Uint8Array): string {
  let out = "";
  for (let i = 0; i < data.length; i += 4) {
    const n = Math.min(4, data.length - i);
    let v = 0;
    for (let k = 0; k < 4; k++) v = v * 256 + (k < n ? data[i + k] : 0);
    if (v === 0 && n === 4) {
      out += "z";
      continue;
    }
    const chars: string[] = [];
    for (let k = 0; k < 5; k++) {
      chars.unshift(String.fromCharCode((v % 85) + 33));
      v = Math.floor(v / 85);
    }
    out += chars.slice(0, n + 1).join("");
  }
  return out + "~>";
}
