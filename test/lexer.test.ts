import assert from "node:assert/strict";
import { test } from "node:test";
import { fromLatin1 } from "../src/bytes.ts";
import { lex } from "../src/syntax/lexer.ts";
import { fixtureBytes } from "./fixture.ts";

test("statements tile the source exactly", () => {
  const src = fixtureBytes();
  const st = lex(src);
  let pos = 0;
  for (const s of st) {
    assert.equal(s.start, pos);
    pos = s.end;
  }
  assert.equal(pos, src.length);
});

test("%_ regions are flagged hidden, mid-line too", () => {
  const st = lex(fromLatin1("1 2 %_3 Bs\r%_n\rf\r"));
  assert.deepEqual(st.map((s) => [s.op, s.hidden, s.args]), [["Bs", true, [1, 2, 3]], ["n", true, []], ["f", false, []]]);
});

test("raster payload includes the undeclared alpha plane", () => {
  const st = lex(fixtureBytes());
  const xi = st.find((s) => s.op === "XI")!;
  assert.ok(xi.data);
  assert.equal(xi.data[1] - xi.data[0], 2 * 2 * 3 + 2 * 2);
  assert.ok(st.some((s) => s.op === "%" && s.text === "%EndData"));
});

test("strings, names, arrays and hex", () => {
  const [s] = lex(fromLatin1("(a\\(b\\)\\101) /Name [1 [2]] <0aFF> op"));
  assert.deepEqual(s.args, [{ t: "s", v: "a(b)A" }, { t: "n", v: "Name" }, { t: "a", v: [1, { t: "a", v: [2] }] }, { t: "h", v: "0aFF" }]);
});
