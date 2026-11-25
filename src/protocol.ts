export interface Member {
  name: string;
  /** 1-based line in `source` of the member's name. */
  line: number;
  /** Id into `symbols`, 0 if none. */
  symbol: number;
}

export interface DecompiledType {
  type: string;
  source: string;
  members: Member[];
  /** `[gap, length, kind, symbol]` quadruples; `gap` counts characters since the previous token's end, `symbol` is an id or 0. */
  tokens: number[];
  /** Symbol id `n` is `[symbolTypes index, metadata token]` at `symbols[2n - 2]`, `symbols[2n - 1]`. */
  symbols: number[];
  /** Reflection names of the symbols' declaring types. */
  symbolTypes: string[];
}

/** An entity by declaring type and metadata token, equal across decompiled types. */
export interface Symbol {
  type: string;
  token: number;
}

/** The symbol behind an id of `t`, or null for 0. */
export function symbolOf(t: DecompiledType, id: number): Symbol | null {
  return id ? { type: t.symbolTypes[t.symbols[2 * id - 2]], token: t.symbols[2 * id - 1] } : null;
}

export const TOKEN_KINDS = [
  "keyword",
  "type",
  "method",
  "member",
  "string",
  "number",
  "comment",
] as const;

export type TokenKind = (typeof TOKEN_KINDS)[number];

/** One dropped set of assemblies, identified by the SHA-256 of its main assembly. */
export interface AssemblySet {
  key: string;
  main: string;
  /** Assemblies the main assembly's type system resolved, i.e. the ones worth dropping again. */
  used: string[];
  addedAt: number;
}

export interface AssemblyFile {
  name: string;
  bytes: ArrayBuffer;
}

export type Status =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "loading"; main: string }
  | { phase: "decompiling"; type: string; pending: number };

export type Request =
  | { op: "add"; files: AssemblyFile[]; main: string }
  | { op: "sets" }
  | { op: "get"; key: string; type: string }
  | { op: "request"; key: string; type: string };

export type ToWorker = { id: number } & Request;

export type FromWorker =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string; missingAssemblies?: boolean }
  | { status: Status };
