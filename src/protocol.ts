export interface Member {
  name: string;
  /** 1-based line in `source` of the member's name. */
  line: number;
}

export interface DecompiledType {
  type: string;
  source: string;
  members: Member[];
}

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
