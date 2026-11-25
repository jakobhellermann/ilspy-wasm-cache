import assert from "node:assert/strict";
import { test } from "node:test";
import type { DecompiledType } from "../src/protocol.ts";
import { segmentLines } from "../src/segments.ts";

test("splits highlighted source into lines of segments", () => {
  const source = "class A\n{\n\tvoid M() { }\n}";
  // `class` keyword, `A` type, `void` keyword, `M` method with symbol 1
  const tokens = [0, 5, 0, 0, 1, 1, 1, 0, 4, 4, 0, 0, 1, 1, 2, 1];
  const t = {
    type: "A",
    source,
    members: [],
    tokens,
    symbols: [],
    symbolTypes: [],
  } as DecompiledType;
  assert.deepEqual(segmentLines(t), [
    [
      { text: "class", kind: "keyword", symbol: 0 },
      { text: " ", kind: null, symbol: 0 },
      { text: "A", kind: "type", symbol: 0 },
    ],
    [{ text: "{", kind: null, symbol: 0 }],
    [
      { text: "\t", kind: null, symbol: 0 },
      { text: "void", kind: "keyword", symbol: 0 },
      { text: " ", kind: null, symbol: 0 },
      { text: "M", kind: "method", symbol: 1 },
      { text: "() { }", kind: null, symbol: 0 },
    ],
    [{ text: "}", kind: null, symbol: 0 }],
  ]);
});
