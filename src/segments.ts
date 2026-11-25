import { type DecompiledType, TOKEN_KINDS, type TokenKind } from "./protocol.ts";

export interface Segment {
  text: string;
  /** Null for text between highlighted tokens. */
  kind: TokenKind | null;
  /** Symbol id (see `symbolOf`), 0 if none. */
  symbol: number;
}

/** `t.source` split into lines of segments, for rendering highlighted source without an editor. */
export function segmentLines(t: DecompiledType): Segment[][] {
  const lines: Segment[][] = [[]];
  const push = (text: string, kind: TokenKind | null, symbol: number) => {
    const parts = text.split("\n");
    parts.forEach((part, i) => {
      if (i) lines.push([]);
      if (part) lines[lines.length - 1].push({ text: part, kind, symbol });
    });
  };
  let pos = 0;
  for (let i = 0; i < t.tokens.length; i += 4) {
    const start = pos + t.tokens[i];
    const end = start + t.tokens[i + 1];
    push(t.source.slice(pos, start), null, 0);
    push(t.source.slice(start, end), TOKEN_KINDS[t.tokens[i + 2]], t.tokens[i + 3]);
    pos = end;
  }
  push(t.source.slice(pos), null, 0);
  return lines;
}
